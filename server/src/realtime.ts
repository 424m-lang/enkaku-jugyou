import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Server, Socket } from 'socket.io';
import { eq } from 'drizzle-orm';
import type { ClientToServerEvents, PollType, ScreenLayout, ServerToClientEvents } from '@shared';
import { MAX_TASKS } from '@shared';
import { db, schema } from './db';
import { verifyParticipantToken } from './auth';
import {
  getSession,
  toLiveState,
  recordEvent,
  recordPointerSampled,
  handleAudioChunk,
  handleAvChunk,
  effectiveAudio,
  setAudioDefault,
  setParticipantAudio,
  listParticipants,
  startLesson,
  endLesson,
  insertBlankSlide,
  touchParticipants,
  setReactionsEnabled,
  setTasks,
  setTaskConfig,
  setTaskProgress,
  taskProgressOf,
  listTaskProgress,
  tMs,
  type LiveSession,
} from './live/liveSessions';
import {
  savePoll,
  deletePoll,
  openPoll,
  closePoll,
  recordPollAnswer,
  myPollAnswer,
  pollResults,
  publicResults,
  toPublicPoll,
} from './live/polls';
import { recordReaction } from './live/reactions';
import { handleCommentForInsight } from './live/commentInsights';
import {
  ensureTranscribedUntil,
  restoreLiveTranscript,
  startLiveTranscription,
  stopLiveTranscription,
} from './live/liveTranscript';

/** コメント入力中の合図がこの時間途絶えたら入力をやめたとみなす */
const COMPOSING_STALE_MS = 20_000;

type SocketData = {
  /** screen = 教室の大画面（表示専用。授業へ何も送れず、生徒数にも数えない） */
  role: 'teacher' | 'student' | 'screen';
  lessonId: string;
  participantId?: string;
  participantName?: string;
};

export type TypedServer = Server<ClientToServerEvents, ServerToClientEvents, object, SocketData>;
type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

/** トークン照合。長さの違いで落としてから、残りは実行時間を揃えて比較する */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

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
      const auth = socket.handshake.auth as {
        lessonId?: string;
        participantToken?: string;
        screenToken?: string;
      };
      const lessonId = auth.lessonId;
      if (!lessonId) return next(new Error('lessonId が必要です'));

      // 教室スクリーン: 先生がログインしていない教室の端末から開くためのトークン。
      // 表示専用なので生徒トークンより先に判定し、参加者としては扱わない
      if (auth.screenToken) {
        const [lesson] = await db
          .select({ screenToken: schema.lessons.screenToken })
          .from(schema.lessons)
          .where(eq(schema.lessons.id, lessonId));
        if (lesson?.screenToken && safeEqual(lesson.screenToken, auth.screenToken)) {
          socket.data = { role: 'screen', lessonId };
          return next();
        }
        return next(new Error('認証に失敗しました'));
      }

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
    // カメラ映像の配信先。大画面は常に入り、生徒は先生が映像を送るときだけ入る
    const avRoom = `${room}:av`;
    // 音声のみの配信先。大画面は常に入り、生徒は音声を鳴らす設定の生徒だけ入る
    // （教室で受ける生徒はミュートなので、そもそも音声を送る必要が無い）
    const audioRoom = `${room}:audio`;

    await socket.join(room);
    if (role === 'teacher') {
      await socket.join(teacherRoom);
    }
    if (role === 'screen') {
      await socket.join(avRoom);
      await socket.join(audioRoom);
    }
    if (role === 'student' && socket.data.participantId) {
      const pid = socket.data.participantId;
      socket.emit('audio_permission', { audio: effectiveAudio(s, pid) });
      // 自分の進捗だけを返す（他の生徒がどこまで進んだかは生徒には見せない）
      socket.emit('my_task_progress', { taskIds: taskProgressOf(s, pid) });
      // 開いているアンケートに答え済みなら、その内容を戻す（再接続で消えないように）
      if (s.openPollId) {
        const mine = myPollAnswer(s, pid, s.openPollId);
        if (mine) socket.emit('my_poll_answer', { pollId: s.openPollId, answer: mine });
      }
      if (shouldReceiveAudio(s, pid)) await socket.join(audioRoom);
      if (shouldReceiveVideo(s, pid)) await socket.join(avRoom);
    }
    if (role === 'teacher') {
      socket.emit('task_progress_all', await listTaskProgress(s));
      socket.emit('polls_updated', s.polls);
      if (s.openPollId) socket.emit('poll_results', await pollResults(s, s.openPollId));
    }

    const avState = () => ({
      cameraOn: s.cameraOn,
      layout: s.screenLayout,
      videoToStudents: s.videoToStudents,
      avHasAudio: s.avHasAudio,
    });

    // 参加直後に現在のライブ状態のスナップショットを送る
    // （形式未申告の相手には従来のWebMを既定にしておく）
    socket.emit('lesson_state', toLiveState(s));
    socket.emit('av_state', avState());
    // 音声配信中で、この接続が音声を受け取る対象なら、デコーダ初期化用のヘッダチャンクを送る
    if (s.audioInitSegment && s.status === 'live' && socket.rooms.has(audioRoom)) {
      socket.emit('audio_init', toArrayBuffer(s.audioInitSegment), s.audioSeq, audioMimeOf(s));
    }
    // カメラ配信中で、この接続が映像を受け取る対象なら同じくヘッダを送る
    if (s.avInitSegment && s.cameraOn && socket.rooms.has(avRoom)) {
      socket.emit('av_init', toArrayBuffer(s.avInitSegment), s.avSeq, avMimeOf(s));
    }

    await broadcastParticipantCount(io, room);
    await broadcastScreenCount(io, room, teacherRoom);
    await broadcastParticipants(io, s, room, teacherRoom);
    // 途中参加で分母（参加者数）が変わるため、先生の集計を配り直す。
    // これを忘れると「12人中3人」がいつまでも「2人中1人」のまま見え、判断を誤らせる
    if (role === 'student') await broadcastDenominators(io, s, teacherRoom);

    // サーバ再起動後などで文字起こしがまだ動いていなければ復元して再開する。
    // タイマーを同期的に張ってから復元することで、複数接続でも二重起動しない
    if (s.status === 'live' && s.transcribeTimer === null) {
      startLiveTranscription(s);
      void restoreLiveTranscript(s).catch((err) => app.log.error(err));
    }

    // ================= 先生のイベント =================
    if (role === 'teacher') {
      socket.on('start_lesson', async (cb) => {
        try {
          if (s.status === 'ended') return cb({ ok: false, error: 'この授業は終了済みです' });
          if (s.status !== 'live') {
            await startLesson(s);
          }
          startLiveTranscription(s); // 裏で文字起こしを貯め始める
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
          const endMs = tMs(s);
          stopLiveTranscription(s);
          await endLesson(s);
          io.to(room).emit('lesson_ended');
          io.to(room).emit('lesson_state', toLiveState(s));
          cb({ ok: true });
          // 最後まで文字起こしを追いつかせる（終了間際のコメント要約のため。失敗は無視）
          void ensureTranscribedUntil(s, endMs).catch((err) => app.log.error(err));
        } catch (err) {
          app.log.error(err);
          cb({ ok: false, error: '終了に失敗しました' });
        }
      });

      // 音声（文字起こし用の録音と共通）。教室で受けている生徒には音が要らないので、
      // 大画面と、音声を鳴らす設定の生徒だけに中継する
      socket.on('audio_chunk', async (chunk, mime) => {
        if (s.status !== 'live') return;
        try {
          const buf = Buffer.from(chunk as ArrayBuffer);
          const { isInit, seq } = await handleAudioChunk(s, buf, mime);
          // 先頭チャンクだけは形式を添える（受け手はこれを見てデコーダを作る）
          if (isInit) io.to(audioRoom).emit('audio_init', chunk, seq, audioMimeOf(s));
          else io.to(audioRoom).emit('audio_chunk', chunk, seq);
        } catch (err) {
          app.log.error(err);
        }
      });

      // カメラ映像（音声込み）。保存はせず、大画面と対象の生徒にだけ中継する
      socket.on('av_chunk', (chunk, mime) => {
        if (!s.cameraOn) return;
        try {
          const { isInit, seq } = handleAvChunk(s, Buffer.from(chunk as ArrayBuffer), mime);
          if (isInit) io.to(avRoom).emit('av_init', chunk, seq, avMimeOf(s));
          else io.to(avRoom).emit('av_chunk', chunk, seq);
        } catch (err) {
          app.log.error(err);
        }
      });

      socket.on('camera_state', (p) => {
        s.cameraOn = !!p?.on;
        s.avHasAudio = s.cameraOn && p?.hasAudio !== false;
        if (!s.cameraOn) {
          s.avInitSegment = null;
          // カメラを切ったら大画面は自動でスライド全画面に戻す（余白が出ないように）
          if (s.screenLayout === 'video') s.screenLayout = 'slide';
        }
        io.to(room).emit('av_state', avState());
      });

      socket.on('set_av_config', (p) => {
        if (p?.layout && isScreenLayout(p.layout)) s.screenLayout = p.layout;
        if (typeof p?.videoToStudents === 'boolean' && p.videoToStudents !== s.videoToStudents) {
          s.videoToStudents = p.videoToStudents;
          void syncStudentAv(io, s, room, avRoom, audioRoom).catch((err) => app.log.error(err));
        }
        io.to(room).emit('av_state', avState());
      });

      // 生徒端末の音声: まとめて切り替え（教室で受ける授業は全員OFFが既定）
      socket.on('set_audio_default', async (p, cb) => {
        try {
          if (p?.mode !== 'on' && p?.mode !== 'off') return cb({ ok: false });
          await setAudioDefault(s, p.mode);
          io.to(room).emit('lesson_state', toLiveState(s));
          await syncStudentAv(io, s, room, avRoom, audioRoom);
          await broadcastParticipants(io, s, room, teacherRoom);
          cb({ ok: true });
        } catch (err) {
          app.log.error(err);
          cb({ ok: false });
        }
      });

      // 生徒端末の音声: 1人だけ切り替え（教室に1人だけ遠隔がいる場合など）
      socket.on('set_participant_audio', async (p, cb) => {
        try {
          const mode = p?.mode;
          if (mode !== 'on' && mode !== 'off' && mode !== null) return cb({ ok: false });
          if (typeof p?.participantId !== 'string') return cb({ ok: false });
          await setParticipantAudio(s, p.participantId, mode);
          await syncStudentAv(io, s, room, avRoom, audioRoom);
          await broadcastParticipants(io, s, room, teacherRoom);
          cb({ ok: true });
        } catch (err) {
          app.log.error(err);
          cb({ ok: false });
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

      // タスク一覧の設定。授業前の事前設定と授業中の追加が同じ経路を通る
      socket.on('set_tasks', async (p, cb) => {
        try {
          if (!Array.isArray(p?.tasks)) return cb({ ok: false, error: '入力が不正です' });
          if (p.tasks.length > MAX_TASKS) {
            return cb({ ok: false, error: `タスクは${MAX_TASKS}個までです` });
          }
          if (p.tasks.some((t) => typeof t?.label !== 'string')) {
            return cb({ ok: false, error: '入力が不正です' });
          }
          const tasks = await setTasks(s, p.tasks);
          io.to(room).emit('lesson_state', toLiveState(s));
          // タスクが消えると完了記録も外れるので、先生側の集計を配り直す
          io.to(teacherRoom).emit('task_progress_all', await listTaskProgress(s));
          cb({ ok: true, tasks });
        } catch (err) {
          app.log.error(err);
          cb({ ok: false });
        }
      });

      socket.on('set_task_config', async (p, cb) => {
        try {
          if (p?.mode !== undefined && p.mode !== 'sequential' && p.mode !== 'free') {
            return cb({ ok: false });
          }
          if (p?.active !== undefined && typeof p.active !== 'boolean') return cb({ ok: false });
          await setTaskConfig(s, p ?? {});
          io.to(room).emit('lesson_state', toLiveState(s));
          cb({ ok: true });
        } catch (err) {
          app.log.error(err);
          cb({ ok: false });
        }
      });

      socket.on('set_reactions_enabled', async (p, cb) => {
        try {
          if (typeof p?.enabled !== 'boolean') return cb({ ok: false });
          await setReactionsEnabled(s, p.enabled);
          io.to(room).emit('lesson_state', toLiveState(s));
          cb({ ok: true });
        } catch (err) {
          app.log.error(err);
          cb({ ok: false });
        }
      });

      // ---- アンケート ----
      // 設問一覧は先生にだけ配る（生徒に配ると次に聞く質問が見えてしまう）
      socket.on('save_poll', async (p, cb) => {
        try {
          if (!isPollType(p?.type)) return cb({ ok: false, error: '設問の型が不正です' });
          const { poll, error } = await savePoll(s, p);
          if (error || !poll) return cb({ ok: false, error });
          io.to(teacherRoom).emit('polls_updated', s.polls);
          cb({ ok: true, poll });
        } catch (err) {
          app.log.error(err);
          cb({ ok: false });
        }
      });

      socket.on('delete_poll', async (p, cb) => {
        try {
          if (typeof p?.pollId !== 'string') return cb({ ok: false });
          const wasOpen = s.openPollId === p.pollId;
          await deletePoll(s, p.pollId);
          io.to(teacherRoom).emit('polls_updated', s.polls);
          if (wasOpen) {
            io.to(room).emit('poll_closed', { pollId: p.pollId, results: null });
            io.to(room).emit('lesson_state', toLiveState(s));
          }
          cb({ ok: true });
        } catch (err) {
          app.log.error(err);
          cb({ ok: false });
        }
      });

      socket.on('open_poll', async (p, cb) => {
        try {
          if (s.status !== 'live') return cb({ ok: false, error: '授業を開始してください' });
          if (typeof p?.pollId !== 'string') return cb({ ok: false });
          const previous = s.openPollId;
          const poll = await openPoll(s, p.pollId);
          if (!poll) return cb({ ok: false, error: '設問が見つかりません' });
          // 別の設問が開いていた場合、その締め切りも生徒へ知らせる
          if (previous && previous !== poll.id) {
            io.to(room).emit('poll_closed', { pollId: previous, results: null });
          }
          io.to(room).emit('poll_open', toPublicPoll(poll));
          io.to(teacherRoom).emit('polls_updated', s.polls);
          io.to(teacherRoom).emit('poll_results', await pollResults(s, poll.id));
          cb({ ok: true });
        } catch (err) {
          app.log.error(err);
          cb({ ok: false });
        }
      });

      socket.on('close_poll', async (p, cb) => {
        try {
          if (typeof p?.pollId !== 'string') return cb({ ok: false });
          const type = s.polls.find((x) => x.id === p.pollId)?.type;
          await closePoll(s, p.pollId);
          const results = await pollResults(s, p.pollId);
          // 自由記述は他の生徒に見せない（誰が書いたかが分かってしまうため）。
          // 見せられる集計が無いので、結果表示そのものを出さない
          const reveal = p.reveal && type !== 'text';
          io.to(room).emit('poll_closed', {
            pollId: p.pollId,
            results: reveal ? publicResults(results) : null,
          });
          io.to(teacherRoom).emit('polls_updated', s.polls);
          io.to(teacherRoom).emit('poll_results', results);
          cb({ ok: true });
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
          // ボタンを使わない授業ではボタン反応を受け付けない（コメントは別扱いで残す）。
          // オフラインキューに溜まっていた反応が後から届いても記録されない
          if (input.kind !== 'comment' && !s.reactionsEnabled) return cb({ ok: false });
          if (
            input.kind !== 'comment' &&
            !s.reactionButtons.some((b) => b.key === input.kind)
          ) {
            return cb({ ok: false });
          }
          const pid = socket.data.participantId!;
          const rec = await recordReaction(
            s,
            { id: pid, displayName: socket.data.participantName! },
            input
          );
          cb({ ok: true }); // デバウンスで集約された場合も生徒側には成功として返す
          if (rec) {
            const { item, composeStartMs } = rec;
            io.to(teacherRoom).emit('reaction_feed', item, s.counts);
            if (item.kind === 'comment' && item.comment) {
              handleCommentForInsight(io, s, {
                reactionId: item.id,
                text: item.comment,
                participantName: item.participantName,
                tMs: item.tMs,
                slideId:
                  typeof input.slideId === 'string' && input.slideId.length <= 64
                    ? input.slideId
                    : null,
                composeStartMs: composeStartMs ?? item.tMs,
              });
            }
          }
        } catch (err) {
          app.log.error(err);
          cb({ ok: false });
        }
      });

      // タスクの完了・取り消し
      socket.on('task_set', async (p, cb) => {
        try {
          if (s.status !== 'live' || !s.tasksActive) return cb({ ok: false });
          if (typeof p?.taskId !== 'string' || typeof p?.done !== 'boolean') {
            return cb({ ok: false });
          }
          const pid = socket.data.participantId!;
          const taskIds = await setTaskProgress(s, pid, p.taskId, p.done);
          cb({ ok: true });
          if (!taskIds) return; // 変化なし（同じ状態の再送）
          socket.emit('my_task_progress', { taskIds });
          io.to(teacherRoom).emit('task_progress', {
            participantId: pid,
            participantName: socket.data.participantName!,
            taskIds,
            updatedAtMs: tMs(s),
          });
        } catch (err) {
          app.log.error(err);
          cb({ ok: false });
        }
      });

      // アンケートへの回答。締め切りまでは送り直すたびに上書きされる
      socket.on('poll_answer', async (p, cb) => {
        try {
          if (s.status !== 'live') return cb({ ok: false });
          if (typeof p?.pollId !== 'string') return cb({ ok: false });
          const pid = socket.data.participantId!;
          const answer = await recordPollAnswer(s, pid, p.pollId, p);
          if (!answer) return cb({ ok: false });
          cb({ ok: true });
          socket.emit('my_poll_answer', { pollId: p.pollId, answer });
          io.to(teacherRoom).emit('poll_results', await pollResults(s, p.pollId));
        } catch (err) {
          app.log.error(err);
          cb({ ok: false });
        }
      });
    }

    socket.on('disconnect', async () => {
      await broadcastParticipantCount(io, room);
      await broadcastScreenCount(io, room, teacherRoom);
      if (socket.data.participantId) {
        s.composing.delete(socket.data.participantId);
        await touchParticipants([socket.data.participantId]).catch(() => {});
      }
      if (socket.data.role === 'student') {
        await broadcastParticipants(io, s, room, teacherRoom);
        await broadcastDenominators(io, s, teacherRoom);
      }
    });
  });
}

function isScreenLayout(v: string): v is ScreenLayout {
  return v === 'slide' || v === 'video' || v === 'slide-only';
}

function isPollType(v: unknown): v is PollType {
  return v === 'single' || v === 'multiple' || v === 'scale' || v === 'text';
}

/**
 * タスク・アンケートの集計を先生へ配り直す。
 * どちらも分母が参加者数なので、生徒の出入りで数字が変わる
 */
async function broadcastDenominators(
  io: TypedServer,
  s: LiveSession,
  teacherRoom: string
): Promise<void> {
  io.to(teacherRoom).emit('task_progress_all', await listTaskProgress(s));
  if (s.openPollId) {
    io.to(teacherRoom).emit('poll_results', await pollResults(s, s.openPollId));
  }
}

/** Buffer をコピーせず ArrayBuffer として渡す（Socket.IOのバイナリ送信用） */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** その生徒の端末で音声を鳴らす設定か（＝音声を送る必要があるか） */
function shouldReceiveAudio(s: LiveSession, participantId: string): boolean {
  return effectiveAudio(s, participantId) === 'on';
}

/**
 * その生徒がカメラ映像を受け取る対象か。
 * 映像は通信量が大きいので、先生が明示的に送るとき、かつ端末で音声を鳴らしている
 * （＝教室ではなく遠隔で受けている）生徒だけに配信する。
 */
function shouldReceiveVideo(s: LiveSession, participantId: string): boolean {
  return s.videoToStudents && effectiveAudio(s, participantId) === 'on';
}

/**
 * 生徒それぞれに音声の可否を通知し、音声・映像の配信先も現在の設定に合わせ直す。
 * 教室で受けている（ミュートの）生徒には音声も映像も送らないので通信量を使わない。
 * 音声の設定を変えると両方の対象が変わるため、常にまとめて更新する。
 */
/**
 * 中継する音声・映像の形式。
 * 先生の環境がAAC/MP4を選べばそれを、選べなければWebM/Opusを配る。
 * 形式が届いていない場合（古いクライアント）は従来のWebMとみなす。
 */
function audioMimeOf(s: LiveSession): string {
  return s.audioMime ?? 'audio/webm;codecs=opus';
}

function avMimeOf(s: LiveSession): string {
  return s.avMime ?? 'video/webm;codecs="vp8,opus"';
}

async function syncStudentAv(
  io: TypedServer,
  s: LiveSession,
  room: string,
  avRoom: string,
  audioRoom: string
): Promise<void> {
  const sockets = await io.in(room).fetchSockets();
  for (const sock of sockets) {
    const pid = sock.data.participantId;
    if (sock.data.role !== 'student' || !pid) continue;
    sock.emit('audio_permission', { audio: effectiveAudio(s, pid) });

    const wantsAudio = shouldReceiveAudio(s, pid);
    if (wantsAudio && !sock.rooms.has(audioRoom)) {
      sock.join(audioRoom);
      // 途中から音声を受け取り始める端末にはデコーダ初期化用のヘッダが要る
      if (s.audioInitSegment && s.status === 'live') {
        sock.emit('audio_init', toArrayBuffer(s.audioInitSegment), s.audioSeq, audioMimeOf(s));
      }
    } else if (!wantsAudio && sock.rooms.has(audioRoom)) {
      sock.leave(audioRoom);
    }

    const wantsVideo = shouldReceiveVideo(s, pid);
    if (wantsVideo && !sock.rooms.has(avRoom)) {
      sock.join(avRoom);
      if (s.avInitSegment && s.cameraOn) {
        sock.emit('av_init', toArrayBuffer(s.avInitSegment), s.avSeq, avMimeOf(s));
      }
    } else if (!wantsVideo && sock.rooms.has(avRoom)) {
      sock.leave(avRoom);
    }
  }
}

async function broadcastParticipantCount(io: TypedServer, room: string): Promise<void> {
  const sockets = await io.in(room).fetchSockets();
  const count = sockets.filter((x) => x.data.role === 'student').length;
  io.to(room).emit('participant_count', count);
}

/** 教室の大画面が何台つながっているか（0なら投影されていないと先生が気づける） */
async function broadcastScreenCount(
  io: TypedServer,
  room: string,
  teacherRoom: string
): Promise<void> {
  const sockets = await io.in(room).fetchSockets();
  io.to(teacherRoom).emit('screen_count', sockets.filter((x) => x.data.role === 'screen').length);
}

async function broadcastParticipants(
  io: TypedServer,
  s: LiveSession,
  room: string,
  teacherRoom: string
): Promise<void> {
  const sockets = await io.in(room).fetchSockets();
  const online = new Set<string>();
  for (const sock of sockets) {
    if (sock.data.role === 'student' && sock.data.participantId) {
      online.add(sock.data.participantId);
    }
  }
  io.to(teacherRoom).emit('participants', await listParticipants(s, online));
}
