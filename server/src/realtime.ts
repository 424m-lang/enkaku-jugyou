import type { FastifyInstance } from 'fastify';
import type { Server, Socket } from 'socket.io';
import { eq } from 'drizzle-orm';
import type { ClientToServerEvents, ServerToClientEvents } from '@shared';
import { db, schema } from './db';
import { verifyParticipantToken } from './auth';
import {
  getSession,
  toLiveState,
  recordEvent,
  recordPointerSampled,
  handleAudioChunk,
  startLesson,
  endLesson,
  insertBlankSlide,
  touchParticipants,
  tMs,
} from './live/liveSessions';
import { recordReaction } from './live/reactions';
import { handleCommentForInsight } from './live/commentInsights';

/** コメント入力中の合図がこの時間途絶えたら入力をやめたとみなす */
const COMPOSING_STALE_MS = 20_000;

type SocketData = {
  role: 'teacher' | 'student';
  lessonId: string;
  participantId?: string;
  participantName?: string;
};

export type TypedServer = Server<ClientToServerEvents, ServerToClientEvents, object, SocketData>;
type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setupRealtime(app: FastifyInstance, io: TypedServer): void {
  // ---- 接続時の認証 ----
  io.use(async (socket, next) => {
    try {
      const auth = socket.handshake.auth as { lessonId?: string; participantToken?: string };
      const lessonId = auth.lessonId;
      if (!lessonId) return next(new Error('lessonId が必要です'));

      // 生徒: 参加トークンが明示されていればそちらを優先する
      // （先生と同じ端末で生徒画面を開いた場合にCookieより優先されるように）
      const participant = await verifyParticipantToken(auth.participantToken);
      if (participant && participant.lessonId === lessonId) {
        socket.data = {
          role: 'student',
          lessonId,
          participantId: participant.id,
          participantName: participant.displayName,
        };
        return next();
      }

      // 先生: セッションCookieで認証し、授業の所有者であること
      const cookies = parseCookies(socket.request.headers.cookie);
      const raw = cookies['teacher_session'];
      if (raw) {
        const unsigned = app.unsignCookie(raw);
        if (unsigned.valid && unsigned.value) {
          const [lesson] = await db
            .select({ teacherId: schema.lessons.teacherId })
            .from(schema.lessons)
            .where(eq(schema.lessons.id, lessonId));
          if (lesson && lesson.teacherId === unsigned.value) {
            socket.data = { role: 'teacher', lessonId };
            return next();
          }
        }
      }

      return next(new Error('認証に失敗しました'));
    } catch (err) {
      return next(err as Error);
    }
  });

  io.on('connection', async (socket) => {
    const { role, lessonId } = socket.data;
    const s = await getSession(lessonId);
    if (!s) {
      socket.disconnect(true);
      return;
    }
    const room = `lesson:${lessonId}`;
    const teacherRoom = `${room}:teacher`;

    await socket.join(room);
    if (role === 'teacher') {
      await socket.join(teacherRoom);
    }

    // 参加直後に現在のライブ状態のスナップショットを送る
    socket.emit('lesson_state', toLiveState(s));
    // 音声配信中なら、デコーダ初期化用のヘッダチャンクを送る
    if (s.audioInitSegment && s.status === 'live') {
      socket.emit(
        'audio_init',
        s.audioInitSegment.buffer.slice(
          s.audioInitSegment.byteOffset,
          s.audioInitSegment.byteOffset + s.audioInitSegment.byteLength
        ) as ArrayBuffer,
        s.audioSeq
      );
    }

    await broadcastParticipantCount(io, room);

    // ================= 先生のイベント =================
    if (role === 'teacher') {
      socket.on('start_lesson', async (cb) => {
        try {
          if (s.status === 'ended') return cb({ ok: false, error: 'この授業は終了済みです' });
          if (s.status !== 'live') {
            await startLesson(s);
          }
          io.to(room).emit('lesson_started');
          io.to(room).emit('lesson_state', toLiveState(s));
          cb({ ok: true });
        } catch (err) {
          app.log.error(err);
          cb({ ok: false, error: '開始に失敗しました' });
        }
      });

      socket.on('end_lesson', async (cb) => {
        try {
          if (s.status !== 'live') return cb({ ok: false, error: '授業中ではありません' });
          await endLesson(s);
          io.to(room).emit('lesson_ended');
          io.to(room).emit('lesson_state', toLiveState(s));
          cb({ ok: true });
        } catch (err) {
          app.log.error(err);
          cb({ ok: false, error: '終了に失敗しました' });
        }
      });

      socket.on('audio_chunk', async (chunk) => {
        if (s.status !== 'live') return;
        try {
          const buf = Buffer.from(chunk as ArrayBuffer);
          const { isInit, seq } = await handleAudioChunk(s, buf);
          if (isInit) {
            socket.to(room).emit('audio_init', chunk, seq);
          } else {
            socket.to(room).emit('audio_chunk', chunk, seq);
          }
        } catch (err) {
          app.log.error(err);
        }
      });

      socket.on('slide_change', async (p) => {
        if (s.status !== 'live') {
          s.currentSlideId = p.slideId; // 開始前のプレビュー移動は記録しない
          socket.to(room).emit('slide_change', { ...p, tMs: 0 });
          return;
        }
        const ev = await recordEvent(s, 'slide_change', p);
        socket.to(room).emit('slide_change', { ...p, tMs: ev.tMs });
      });

      socket.on('stroke', async (p) => {
        if (s.status !== 'live') return;
        const ev = await recordEvent(s, 'stroke', p);
        socket.to(room).emit('stroke', { ...p, tMs: ev.tMs });
      });

      socket.on('stroke_progress', (p) => {
        // 描画途中のプレビュー: 記録せずそのまま配信（低優先・欠落許容）
        socket.to(room).volatile.emit('stroke_progress', p);
      });

      socket.on('pointer', (p) => {
        socket.to(room).volatile.emit('pointer', p);
        if (s.status === 'live') {
          void recordPointerSampled(s, p).catch((err) => app.log.error(err));
        }
      });

      socket.on('clear_slide', async (p) => {
        if (s.status !== 'live') return;
        const ev = await recordEvent(s, 'clear_slide', p);
        socket.to(room).emit('clear_slide', { ...p, tMs: ev.tMs });
      });

      socket.on('insert_blank_slide', async (afterPosition, cb) => {
        try {
          const { slides, newSlideId } = await insertBlankSlide(s, afterPosition);
          io.to(room).emit('slides_updated', slides);
          cb({ ok: true, slides, newSlideId });
        } catch (err) {
          app.log.error(err);
          cb({ ok: false });
        }
      });

    }

    // ================= 生徒のイベント =================
    if (role === 'student') {
      // コメント入力中の合図: 最初の合図の時刻を「入力開始時刻」として記録し、
      // コメント・振り返りのAI分析対象の音声範囲を決めるのに使う
      socket.on('comment_composing', (p) => {
        if (s.status !== 'live') return;
        const pid = socket.data.participantId;
        if (!pid) return;
        if (p && p.active && typeof p.slideId === 'string' && p.slideId.length <= 64) {
          const prev = s.composing.get(pid);
          // 合図が続いている間は入力開始時刻を保持し、途絶えていたら取り直す
          const startTMs =
            prev && Date.now() - prev.atEpochMs <= COMPOSING_STALE_MS ? prev.startTMs : tMs(s);
          s.composing.set(pid, { slideId: p.slideId, startTMs, atEpochMs: Date.now() });
        } else {
          s.composing.delete(pid);
        }
      });

      socket.on('reaction', async (input, cb) => {
        try {
          if (s.status !== 'live') return cb({ ok: false });
          if (
            input.kind !== 'comment' &&
            !s.reactionButtons.some((b) => b.key === input.kind)
          ) {
            return cb({ ok: false });
          }
          const pid = socket.data.participantId!;
          // 入力開始時刻は recordReaction が composing を消す前に取り出しておく
          const compose = input.kind === 'comment' ? s.composing.get(pid) : undefined;
          const item = await recordReaction(
            s,
            { id: pid, displayName: socket.data.participantName! },
            input
          );
          cb({ ok: true }); // デバウンスで集約された場合も生徒側には成功として返す
          if (item) {
            io.to(teacherRoom).emit('reaction_feed', item, s.counts);
            if (item.kind === 'comment' && item.comment) {
              // 合図が無い/途絶えていた場合は送信直前に打ち始めたとみなす
              const composeStartMs =
                compose && Date.now() - compose.atEpochMs <= COMPOSING_STALE_MS
                  ? Math.min(compose.startTMs, item.tMs)
                  : Math.max(0, item.tMs - 5_000);
              handleCommentForInsight(io, s, {
                reactionId: item.id,
                text: item.comment,
                participantName: item.participantName,
                tMs: item.tMs,
                slideId:
                  typeof input.slideId === 'string' && input.slideId.length <= 64
                    ? input.slideId
                    : null,
                composeStartMs,
              });
            }
          }
        } catch (err) {
          app.log.error(err);
          cb({ ok: false });
        }
      });
    }

    socket.on('disconnect', async () => {
      await broadcastParticipantCount(io, room);
      if (socket.data.participantId) {
        s.composing.delete(socket.data.participantId);
        await touchParticipants([socket.data.participantId]).catch(() => {});
      }
    });
  });
}

async function broadcastParticipantCount(io: TypedServer, room: string): Promise<void> {
  const sockets = await io.in(room).fetchSockets();
  const count = sockets.filter((x) => x.data.role === 'student').length;
  io.to(room).emit('participant_count', count);
}
