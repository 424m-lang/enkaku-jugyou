import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Server, Socket } from 'socket.io';
import { eq } from 'drizzle-orm';
import type {
  AudioCanPlay,
  AudioFormat,
  ClientBrowser,
  ClientEnvironment,
  ClientPlatform,
  ClientToServerEvents,
  PollType,
  ScreenLayout,
  ServerToClientEvents,
  VideoCanPlay,
  VideoFormat,
} from '@shared';
import {
  AUDIO_FORMATS,
  MAX_CAPTION_CHARS,
  MAX_TASKS,
  VIDEO_FORMATS,
  audioFormatFor,
  clampPipPos,
  videoFormatFor,
} from '@shared';
import { db, schema } from './db';
import { verifyParticipantToken } from './auth';
import { captionHistory } from './live/captions';
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
  setCaptionsOnScreen,
  setStudentCaptions,
  dropCaptionWant,
  captionUserCount,
  setReactionButtons,
  setReactionsEnabled,
  setTasks,
  setTaskConfig,
  setTaskProgress,
  taskProgressOf,
  listTaskProgress,
  tMs,
  type LiveSession,
  updateTelemetry,
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
import { handleCommentForInsight, setInsightResolved } from './live/commentInsights';
import {
  ensureTranscribedUntil,
  restoreLiveTranscript,
  startLiveTranscription,
  stopLiveTranscription,
} from './live/liveTranscript';

/** コメント入力中の合図がこの時間途絶えたら入力をやめたとみなす */
const COMPOSING_STALE_MS = 20_000;

type SocketData = {
  /** screen = 教室モニター（表示専用。授業へ何も送れず、生徒数にも数えない） */
  role: 'teacher' | 'student' | 'screen';
  lessonId: string;
  participantId?: string;
  participantName?: string;
  /** その端末が再生できる形式（接続時の申告。先生の端末では使わない） */
  videoCanPlay?: VideoCanPlay;
  audioCanPlay?: AudioCanPlay;
  /** 匿名集計用。タブを再読込しても同じだが、ブラウザを閉じれば失われる乱数 */
  telemetrySessionId?: string;
  /** 生のUser-Agentではなく、クライアント側で丸めた大分類だけ */
  environment?: ClientEnvironment;
  telemetryAudioWaitingAt?: number;
  telemetryAudioStarted?: boolean;
  telemetryReconnectReported?: boolean;
  telemetryAudioStalled?: boolean;
  telemetryAudioUnsupported?: boolean;
  telemetryVideoUnsupported?: boolean;
};

const CLIENT_PLATFORMS = new Set<ClientPlatform>([
  'apple-mobile',
  'android',
  'desktop',
  'other',
]);
const CLIENT_BROWSERS = new Set<ClientBrowser>(['safari', 'chromium', 'firefox', 'other']);

function cleanEnvironment(value: unknown): ClientEnvironment | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const p = value as { platform?: unknown; browser?: unknown };
  if (!CLIENT_PLATFORMS.has(p.platform as ClientPlatform)) return undefined;
  if (!CLIENT_BROWSERS.has(p.browser as ClientBrowser)) return undefined;
  return { platform: p.platform as ClientPlatform, browser: p.browser as ClientBrowser };
}

function cleanTelemetrySessionId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : undefined;
}

/** 映像の配信先は形式ごとに分ける。受け手は自分が再生できる方の部屋にだけ入る */
function avRoomOf(room: string, format: VideoFormat): string {
  return `${room}:av:${format}`;
}

/** 音声も形式別の部屋へ分け、受け手にはOpusかAACの片方だけを送る */
/**
 * 役割ごとのルーム。人数を数えるためだけに使う。
 *
 * 数えるのに io.in(room).fetchSockets() を使うと、**接続の数だけ包み直す**ので、
 * 一斉入室では「入室のたびに全員を並べる」＝人数の二乗になる。
 * 役割ごとに部屋を分けておけば adapter.rooms.get(...).size で一発で数えられる。
 */
function studentRoomOf(room: string): string {
  return `${room}:students`;
}

function screenRoomOf(room: string): string {
  return `${room}:screens`;
}

/** その部屋にいる接続の数（O(1)。中身は見ない） */
function roomSize(io: TypedServer, room: string): number {
  return io.sockets.adapter.rooms.get(room)?.size ?? 0;
}

function audioRoomOf(room: string, format: AudioFormat): string {
  return `${room}:audio:${format}`;
}

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

/** 再接続を重複させない一時キー。値そのものはDBへ保存しない */
function telemetrySessionKey(socket: TypedSocket): string {
  return `${socket.data.role}:${socket.data.telemetrySessionId ?? socket.id}`;
}

function noteConnection(s: LiveSession, socket: TypedSocket): void {
  if (s.status === 'ended') return;
  const key = telemetrySessionKey(socket);
  if (s.telemetrySeenSessions.has(key)) return;
  s.telemetrySeenSessions.add(key);
  updateTelemetry(s, (m) => {
    m.connectionSessions[socket.data.role] += 1;
    const env = socket.data.environment;
    if (env) {
      m.platforms[env.platform] += 1;
      m.browsers[env.browser] += 1;
    } else {
      m.platforms.other += 1;
      m.browsers.other += 1;
    }
  });
}

function noteAudioReceiver(s: LiveSession, socket: TypedSocket, format: AudioFormat): void {
  if (s.status === 'ended') return;
  const key = `${telemetrySessionKey(socket)}:${format}`;
  if (!s.telemetryAudioSeen.has(key)) {
    s.telemetryAudioSeen.add(key);
    updateTelemetry(s, (m) => {
      m.audio.receiverSessions[format] += 1;
    });
  }
  if (s.status === 'live' && !socket.data.telemetryAudioStarted) {
    socket.data.telemetryAudioWaitingAt = Date.now();
  }
}

function noteVideoReceiver(s: LiveSession, socket: TypedSocket, format: VideoFormat): void {
  if (s.status === 'ended') return;
  const key = `${telemetrySessionKey(socket)}:${format}`;
  if (s.telemetryVideoSeen.has(key)) return;
  s.telemetryVideoSeen.add(key);
  updateTelemetry(s, (m) => {
    m.video.receiverSessions[format] += 1;
  });
}

function noteAudioStarted(s: LiveSession, socket: TypedSocket): void {
  if (socket.data.telemetryAudioStarted) return;
  const waitingAt = socket.data.telemetryAudioWaitingAt;
  socket.data.telemetryAudioStarted = true;
  socket.data.telemetryAudioWaitingAt = undefined;
  if (waitingAt === undefined) return;
  const delayMs = Math.max(0, Math.min(120_000, Date.now() - waitingAt));
  updateTelemetry(s, (m) => {
    m.audio.startup.count += 1;
    m.audio.startup.totalMs += delayMs;
    m.audio.startup.maxMs = Math.max(m.audio.startup.maxMs, delayMs);
  });
}

function noteAudioStartedInRoom(io: TypedServer, s: LiveSession, targetRoom: string): void {
  const ids = io.sockets.adapter.rooms.get(targetRoom);
  if (!ids) return;
  for (const id of ids) {
    const receiver = io.sockets.sockets.get(id);
    if (receiver) noteAudioStarted(s, receiver);
  }
}

function noteConcurrency(io: TypedServer, s: LiveSession, room: string): void {
  if (s.status === 'ended') return;
  const students = roomSize(io, studentRoomOf(room));
  const screens = roomSize(io, screenRoomOf(room));
  if (students <= s.telemetry.maxConcurrentStudents && screens <= s.telemetry.maxConcurrentScreens) {
    return;
  }
  updateTelemetry(s, (m) => {
    m.maxConcurrentStudents = Math.max(m.maxConcurrentStudents, students);
    m.maxConcurrentScreens = Math.max(m.maxConcurrentScreens, screens);
  });
}

export function setupRealtime(app: FastifyInstance, io: TypedServer): void {
  // ---- 接続時の認証 ----
  io.use(async (socket, next) => {
    try {
      const auth = socket.handshake.auth as {
        lessonId?: string;
        participantToken?: string;
        screenToken?: string;
        // 新しい画面は音声・映像を分けて申告する。旧画面の平坦な映像申告も受ける
        canPlay?: {
          video?: VideoCanPlay;
          audio?: AudioCanPlay;
          webm?: boolean;
          mp4?: boolean;
        };
        telemetry?: { sessionId?: unknown; environment?: unknown };
      };
      const lessonId = auth.lessonId;
      if (!lessonId) return next(new Error('lessonId が必要です'));
      // 再生できる形式は接続時に受け取る。あとからイベントで届く形にすると
      // 「まだ分からない相手」を抱えた一瞬ができ、先生の録画器が無駄に切り替わる
      const rawCanPlay = auth.canPlay;
      const rawVideo = rawCanPlay?.video ?? rawCanPlay;
      const videoCanPlay: VideoCanPlay | undefined = rawVideo
        ? { webm: !!rawVideo.webm, mp4: !!rawVideo.mp4 }
        : undefined;
      const rawAudio = rawCanPlay?.audio;
      const audioCanPlay: AudioCanPlay | undefined = rawAudio
        ? { webm: !!rawAudio.webm, mp4: !!rawAudio.mp4 }
        : undefined;
      const telemetrySessionId = cleanTelemetrySessionId(auth.telemetry?.sessionId);
      const environment = cleanEnvironment(auth.telemetry?.environment);

      // 教室スクリーン: 先生がログインしていない教室の端末から開くためのトークン。
      // 表示専用なので生徒トークンより先に判定し、参加者としては扱わない
      if (auth.screenToken) {
        const [lesson] = await db
          .select({ screenToken: schema.lessons.screenToken })
          .from(schema.lessons)
          .where(eq(schema.lessons.id, lessonId));
        if (lesson?.screenToken && safeEqual(lesson.screenToken, auth.screenToken)) {
          socket.data = {
            role: 'screen',
            lessonId,
            videoCanPlay,
            audioCanPlay,
            telemetrySessionId,
            environment,
          };
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
          videoCanPlay,
          audioCanPlay,
          telemetrySessionId,
          environment,
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
            socket.data = { role: 'teacher', lessonId, telemetrySessionId, environment };
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
    // ここでの例外はプロセスごと落ちる（socket.ioは接続ハンドラのrejectを拾わない）。
    // 1人の接続の失敗で授業中の全員が切れるのは重すぎるので、その接続だけ切る
    let s: Awaited<ReturnType<typeof getSession>>;
    try {
      s = await getSession(lessonId);
    } catch (err) {
      app.log.error(err);
      socket.disconnect(true);
      return;
    }
    if (!s) {
      socket.disconnect(true);
      return;
    }
    noteConnection(s, socket);
    const room = `lesson:${lessonId}`;
    const teacherRoom = `${room}:teacher`;
    // カメラ映像の配信先。教室モニターは常に入り、生徒は先生が映像を送るときだけ入る。
    // 部屋は形式ごとに分かれていて、この接続が入るのは自分が再生できる方だけ
    const myAvRoom = avRoomOf(room, videoFormatFor(socket.data.videoCanPlay));
    // 音声のみの配信先。教室モニターは常に入り、生徒は音声を鳴らす設定の生徒だけ入る
    // （教室で受ける生徒はミュートなので、そもそも音声を送る必要が無い）
    const myAudioFormat = audioFormatFor(socket.data.audioCanPlay);
    const myAudioRoom = audioRoomOf(room, myAudioFormat);

    await socket.join(room);
    if (role === 'teacher') {
      await socket.join(teacherRoom);
    }
    if (role === 'student') {
      await socket.join(studentRoomOf(room));
    }
    if (role === 'screen') {
      await socket.join(screenRoomOf(room));
      await socket.join(myAvRoom);
      await socket.join(myAudioRoom);
      noteVideoReceiver(s, socket, videoFormatFor(socket.data.videoCanPlay));
      noteAudioReceiver(s, socket, myAudioFormat);
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
      if (shouldReceiveAudio(s, pid)) {
        await socket.join(myAudioRoom);
        noteAudioReceiver(s, socket, myAudioFormat);
      }
      if (shouldReceiveVideo(s, pid)) {
        await socket.join(myAvRoom);
        noteVideoReceiver(s, socket, videoFormatFor(socket.data.videoCanPlay));
      }
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
      pipPos: s.pipPos,
    });
    let audioRestartRequested = false;

    // 字幕を使う生徒が増減したことを全員に配る。
    // 先生の端末はこの lesson_state を見て音声認識を始める・止める
    const broadcastCaptionUse = () => {
      io.to(room).emit('lesson_state', toLiveState(s));
      io.to(teacherRoom).emit('caption_users', captionUserCount(s));
    };

    // 受け手の顔ぶれが変わるたびに、いま必要な形式を先生へ伝え直す。
    // 誰も受け取っていない形式は止めさせ、そのぶんの符号化と通信量を使わせない。
    //
    // **ここでヘッダ（avStreams）を捨ててはいけない**。受け手が一瞬いなくなった
    // だけでもヘッダが消え、戻ってきた相手に何も渡せなくなる。ヘッダが作り直されるのは
    // 録画器を start したときだけなので、先生がカメラを入れ直すまで二度と映らない。
    // 古いヘッダが残っていても、新しい init が届いた時点で受け手が張り直すので害はない
    const sendAvFormats = () => {
      const formats = VIDEO_FORMATS.filter(
        (f) => (io.sockets.adapter.rooms.get(avRoomOf(room, f))?.size ?? 0) > 0
      );
      io.to(teacherRoom).emit('av_formats', { formats });
    };

    /** 音声を受け取る端末が現在必要としている形式だけを先生へ知らせる */
    const sendAudioFormats = () => {
      const formats = AUDIO_FORMATS.filter(
        (f) => (io.sockets.adapter.rooms.get(audioRoomOf(room, f))?.size ?? 0) > 0
      );
      io.to(teacherRoom).emit('audio_formats', { formats });
    };

    // 参加直後に現在のライブ状態のスナップショットを送る
    // （形式未申告の相手には従来のWebMを既定にしておく）
    socket.emit('lesson_state', toLiveState(s));
    socket.emit('av_state', avState());
    // 受け手が増えたので、先生に「いま必要な形式」を配り直す
    sendAvFormats();
    sendAudioFormats();
    if (role === 'teacher') socket.emit('caption_users', captionUserCount(s));
    if (role === 'teacher' && s.status === 'live' && s.audioStreams.size === 0) {
      audioRestartRequested = true;
      socket.emit('audio_restart');
    }
    // 音声配信中で、この接続が音声を受け取る対象なら、デコーダ初期化用のヘッダチャンクを送る
    const myAudioStream = s.audioStreams.get(myAudioFormat);
    if (myAudioStream && s.status === 'live' && socket.rooms.has(myAudioRoom)) {
      socket.emit(
        'audio_init',
        toArrayBuffer(myAudioStream.init),
        myAudioStream.seq,
        myAudioStream.mime
      );
      noteAudioStarted(s, socket);
    }
    // カメラ配信中で、この接続が映像を受け取る対象ならヘッダを送る
    const myStream = s.avStreams.get(videoFormatFor(socket.data.videoCanPlay));
    if (myStream && s.cameraOn && socket.rooms.has(myAvRoom)) {
      socket.emit('av_init', toArrayBuffer(myStream.init), myStream.seq, myStream.mime);
    }

    broadcastParticipantCount(io, room, teacherRoom);
    broadcastScreenCount(io, room, teacherRoom);
    noteConcurrency(io, s, room);
    // 先生がつないだときだけ全件をそろえる（再接続の復元もここ）。
    // 生徒の入室は1人ぶんだけ送る（全件だと一斉入室で人数の二乗になる）
    if (role === 'teacher') {
      await broadcastParticipants(io, s, room, teacherRoom);
    } else if (role === 'student' && socket.data.participantId) {
      sendParticipantChange(
        io,
        s,
        teacherRoom,
        { id: socket.data.participantId, displayName: socket.data.participantName ?? '' },
        true
      );
    }
    // 途中参加で分母（参加者数）が変わるため、先生の集計を配り直す。
    // これを忘れると「12人中3人」がいつまでも「2人中1人」のまま見え、判断を誤らせる
    if (role === 'student') await broadcastDenominators(io, s, teacherRoom);

    // サーバ再起動後などで文字起こしがまだ動いていなければ復元して再開する。
    // タイマーを同期的に張ってから復元することで、複数接続でも二重起動しない
    if (s.status === 'live' && s.transcribeTimer === null) {
      startLiveTranscription(s);
      void restoreLiveTranscript(s).catch((err) => app.log.error(err));
    }

    // ================= 匿名の通信集計 =================
    // 回数だけを受け取り、文字列・参加者ID・時刻列は保存しない。
    // 同じ接続からの連打でも増え続けないよう、状態遷移として扱う。
    socket.on('telemetry', (event) => {
      if (s.status === 'ended') return;
      if (!event || typeof event !== 'object' || typeof event.type !== 'string') return;
      switch (event.type) {
        case 'reconnect':
          if (socket.data.telemetryReconnectReported) return;
          socket.data.telemetryReconnectReported = true;
          updateTelemetry(s, (m) => {
            m.reconnects += 1;
          });
          break;
        case 'audio_stall':
          if (role === 'teacher' || socket.data.telemetryAudioStalled) return;
          socket.data.telemetryAudioStalled = true;
          updateTelemetry(s, (m) => {
            m.audio.stalls += 1;
          });
          break;
        case 'audio_recovered':
          if (!socket.data.telemetryAudioStalled) return;
          socket.data.telemetryAudioStalled = false;
          updateTelemetry(s, (m) => {
            m.audio.recoveries += 1;
          });
          break;
        case 'audio_unsupported':
          if (role === 'teacher' || socket.data.telemetryAudioUnsupported) return;
          socket.data.telemetryAudioUnsupported = true;
          updateTelemetry(s, (m) => {
            m.audio.unsupported += 1;
          });
          break;
        case 'video_unsupported':
          if (role === 'teacher' || socket.data.telemetryVideoUnsupported) return;
          socket.data.telemetryVideoUnsupported = true;
          updateTelemetry(s, (m) => {
            m.video.unsupported += 1;
          });
          break;
      }
    });

    // ================= 先生のイベント =================
    if (role === 'teacher') {
      socket.on('start_lesson', async (cb) => {
        try {
          if (s.status === 'ended') return cb({ ok: false, error: 'この授業は終了済みです' });
          if (s.status !== 'live') {
            await startLesson(s);
          }
          // 開始前から待っていた受信端末について、授業開始から最初の音声までを測る。
          for (const format of AUDIO_FORMATS) {
            const ids = io.sockets.adapter.rooms.get(audioRoomOf(room, format));
            if (!ids) continue;
            for (const id of ids) {
              const receiver = io.sockets.sockets.get(id);
              if (!receiver) continue;
              receiver.data.telemetryAudioStarted = false;
              receiver.data.telemetryAudioWaitingAt = Date.now();
            }
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
      // 教室モニターと、音声を鳴らす設定の生徒だけに中継する
      socket.on('audio_chunk', async (chunk, mime, archive) => {
        if (s.status !== 'live') return;
        try {
          const buf = Buffer.from(chunk as ArrayBuffer);
          const result = await handleAudioChunk(s, buf, mime, archive !== false);
          if (!result) {
            // サーバ再起動後にヘッダより後ろの欠片だけ届いた。録音器を張り直してinitを得る
            if (!audioRestartRequested) {
              audioRestartRequested = true;
              socket.emit('audio_restart');
            }
            return;
          }
          if (result.isInit) audioRestartRequested = false;
          const target = audioRoomOf(room, result.format);
          const receivers = io.sockets.adapter.rooms.get(target)?.size ?? 0;
          updateTelemetry(s, (m) => {
            m.audio.sourceBytes[result.format] += buf.byteLength;
            m.audio.deliveredBytes[result.format] += buf.byteLength * receivers;
          });
          // 先頭チャンクだけは形式を添える（受け手はこれを見てデコーダを作る）
          if (result.isInit) {
            io.to(target).emit('audio_init', chunk, result.seq, result.mime);
            noteAudioStartedInRoom(io, s, target);
          } else {
            io.to(target).emit('audio_chunk', chunk, result.seq);
          }
        } catch (err) {
          app.log.error(err);
        }
      });

      // カメラ映像（音声込み）。保存はせず、教室モニターと対象の生徒にだけ中継する
      socket.on('av_chunk', (chunk, mime) => {
        // 最後にカメラをONにした先生タブだけを送信元として扱う。
        // 複数タブの断片が同じストリームへ混ざると、受け手のデコーダが壊れる。
        if (!s.cameraOn || s.cameraSocketId !== socket.id) return;
        try {
          const r = handleAvChunk(s, Buffer.from(chunk as ArrayBuffer), mime);
          if (!r) return; // ヘッダより前の欠片。受け手はデコードできない
          const target = avRoomOf(room, r.format);
          const bytes = (chunk as ArrayBuffer).byteLength;
          const receivers = io.sockets.adapter.rooms.get(target)?.size ?? 0;
          updateTelemetry(s, (m) => {
            m.video.sourceBytes[r.format] += bytes;
            m.video.deliveredBytes[r.format] += bytes * receivers;
          });
          if (r.isInit) io.to(target).emit('av_init', chunk, r.seq, r.mime);
          else io.to(target).emit('av_chunk', chunk, r.seq);
        } catch (err) {
          app.log.error(err);
        }
      });

      socket.on('camera_state', (p) => {
        const turningOn = !!p?.on;
        // 新しいタブがONにした場合はそのタブへ所有権を移す。古いタブから遅れて届く
        // OFFは、現在の配信を止めないよう無視する。
        if (!turningOn && s.cameraSocketId && s.cameraSocketId !== socket.id) return;
        const wasOn = s.cameraOn;
        s.cameraOn = turningOn;
        if (!wasOn && s.cameraOn && s.status !== 'ended') {
          s.telemetryCameraStartedAt = Date.now();
          updateTelemetry(s, (m) => {
            m.video.cameraStarts += 1;
          });
        } else if (wasOn && !s.cameraOn && s.telemetryCameraStartedAt !== null) {
          const activeMs = Math.max(0, Date.now() - s.telemetryCameraStartedAt);
          s.telemetryCameraStartedAt = null;
          updateTelemetry(s, (m) => {
            m.video.activeMs += activeMs;
          });
        }
        s.cameraSocketId = s.cameraOn ? socket.id : null;
        s.avHasAudio = s.cameraOn && p?.hasAudio !== false;
        if (!s.cameraOn) {
          s.avStreams.clear();
          // カメラを切ったら教室モニターは自動でスライド全画面に戻す（余白が出ないように）
          if (s.screenLayout === 'video') s.screenLayout = 'slide';
        }
        io.to(room).emit('av_state', avState());
      });

      socket.on('set_av_config', (p) => {
        if (p?.layout && isScreenLayout(p.layout)) s.screenLayout = p.layout;
        const pip = clampPipPos(p?.pipPos);
        if (pip) s.pipPos = pip;
        if (typeof p?.videoToStudents === 'boolean' && p.videoToStudents !== s.videoToStudents) {
          s.videoToStudents = p.videoToStudents;
          void syncStudentAv(io, s, room).catch((err) => app.log.error(err));
        }
        io.to(room).emit('av_state', avState());
      });

      // 生徒端末の音声: まとめて切り替え（教室で受ける授業は全員OFFが既定）
      socket.on('set_audio_default', async (p, cb) => {
        try {
          if (p?.mode !== 'on' && p?.mode !== 'off') return cb({ ok: false });
          await setAudioDefault(s, p.mode);
          io.to(room).emit('lesson_state', toLiveState(s));
          await syncStudentAv(io, s, room);
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
          await syncStudentAv(io, s, room);
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

      // 開始前の書き込みも記録する（tMsは0＝「授業が始まった時点で既に書いてあった」）。
      // 板書を準備してから授業を始める使い方があり、開いたまま放置して
      // 読み込み直したときに消えてしまうのを防ぐ
      socket.on('stroke', async (p) => {
        if (s.status === 'ended') return;
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
        if (s.status === 'ended') return;
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

      socket.on('set_insight_resolved', async (p, cb) => {
        try {
          if (typeof p?.insightId !== 'string' || typeof p?.resolved !== 'boolean') {
            return cb({ ok: false });
          }
          const updated = await setInsightResolved(s.lessonId, p.insightId, p.resolved);
          if (updated) io.to(teacherRoom).emit('comment_insight', updated);
          cb({ ok: !!updated });
        } catch (err) {
          app.log.error(err);
          cb({ ok: false });
        }
      });

      socket.on('set_reaction_buttons', async (p, cb) => {
        try {
          if (!Array.isArray(p?.buttons)) return cb({ ok: false });
          const { error } = await setReactionButtons(s, p.buttons);
          if (error) return cb({ ok: false, error });
          io.to(room).emit('lesson_state', toLiveState(s));
          cb({ ok: true });
        } catch (err) {
          app.log.error(err);
          cb({ ok: false });
        }
      });

      // ---- 自動字幕 ----
      // 先生の端末のブラウザ音声認識の結果を、そのまま参加者へ配る。
      // 音声の中継とは別経路で、遅延1秒未満で届く（音声はサーバ側の文字起こしを
      // 待つと10秒以上遅れ、耳の不自由な生徒には使えないため）。
      socket.on('caption', async (p) => {
        if (s.status !== 'live' || !s.captionsEnabled) return;
        const text = String(p?.text ?? '').trim().slice(0, MAX_CAPTION_CHARS);
        if (!text) return;
        const t = tMs(s);
        io.to(room).emit('caption', { text, final: !!p.final, tMs: t });
        // 記録するのは確定ぶんだけ。暫定は同じ発話が何度も届くので残さない
        if (p.final) {
          try {
            await recordEvent(s, 'caption', { text }, t);
          } catch (err) {
            app.log.error(err);
          }
        }
      });

      socket.on('set_captions', async (p, cb) => {
        try {
          if (typeof p?.onScreen !== 'boolean') return cb({ ok: false });
          await setCaptionsOnScreen(s, p.onScreen);
          io.to(room).emit('lesson_state', toLiveState(s));
          cb({ ok: true });
        } catch (err) {
          app.log.error(err);
          cb({ ok: false });
        }
      });

      // 音声認識が動かないことを生徒にも伝える（出てこない理由が分かるように）
      socket.on('set_caption_status', (p) => {
        const unavailable = !!p?.unavailable;
        if (unavailable === s.captionsUnavailable) return;
        s.captionsUnavailable = unavailable;
        io.to(room).emit('lesson_state', toLiveState(s));
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

      // 締め切ったあとに結果を見せる／引っ込める。
      // 締め切りと結果表示を分けてあるので、先生は集計を見てから見せるか決められる
      socket.on('reveal_poll', async (p, cb) => {
        try {
          if (typeof p?.pollId !== 'string') return cb({ ok: false });
          const poll = s.polls.find((x) => x.id === p.pollId);
          if (!poll) return cb({ ok: false, error: '設問が見つかりません' });
          if (!p.reveal) {
            io.to(room).emit('poll_reveal', { pollId: p.pollId, poll: null, results: null });
            return cb({ ok: true });
          }
          // 自由記述は誰が書いたかが分かってしまうため、生徒には見せない
          if (poll.type === 'text') {
            return cb({ ok: false, error: '自由記述の回答は生徒に見せられません' });
          }
          const results = await pollResults(s, p.pollId);
          io.to(room).emit('poll_reveal', {
            pollId: p.pollId,
            poll: toPublicPoll(poll),
            results: publicResults(results),
          });
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
      // 自分の端末に字幕を出す / 消す。
      // 1人でもONなら先生の端末で音声認識が始まり、全員OFFで止まる。
      // 誰がONにしたかは先生にも他の生徒にも見せない（人数だけ先生に届く）
      // 先生の映像を受け取るか。閉じたら配信を止める（見ていないものに帯域を使わせない）
      socket.on('set_my_video', (p, cb) => {
        const pid = socket.data.participantId;
        if (!pid) return cb({ ok: false });
        const wasClosed = s.videoClosedBy.has(pid);
        if (p?.on) s.videoClosedBy.delete(pid);
        else if (!wasClosed) {
          s.videoClosedBy.add(pid);
          // 接続時の復元は「新しく閉じた」ではない。数えると再起動のたびに水増しされる
          if (s.status !== 'ended' && !p?.restore) {
            updateTelemetry(s, (m) => {
              m.video.closedByStudents += 1;
            });
          }
        }
        // 生徒は接続のたびに現在の希望を送り直すので、変わっていなければ何もしない。
        // syncStudentAv は在室者**全員**へ audio_permission を送り直すため、
        // そのままでは授業開始の一斉入室で人数の二乗ぶんの通信になる
        if (s.videoClosedBy.has(pid) !== wasClosed) {
          void syncStudentAv(io, s, room).catch((err) => app.log.error(err));
        }
        cb({ ok: true });
      });

      socket.on('set_my_captions', (p, cb) => {
        const pid = socket.data.participantId;
        if (!pid) return cb({ ok: false });
        setStudentCaptions(s, socket.id, pid, !!p?.on);
        // 人数の表示が変わるので、認識の要否が変わらなくても配り直す
        broadcastCaptionUse();
        cb({ ok: true });
      });

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
          const kind = typeof input?.kind === 'string' ? input.kind.trim() : '';
          if (!kind || kind.length > 40) return cb({ ok: false });
          const comment =
            kind === 'comment' && typeof input?.comment === 'string'
              ? input.comment.trim().slice(0, 200)
              : undefined;
          if (kind === 'comment' && !comment) return cb({ ok: false });
          const sanitized = {
            kind,
            comment,
            slideId:
              typeof input?.slideId === 'string' && input.slideId.length <= 64
                ? input.slideId
                : undefined,
            delayMs:
              typeof input?.delayMs === 'number' && Number.isFinite(input.delayMs)
                ? Math.max(0, input.delayMs)
                : 0,
          };
          // ボタンを使わない授業ではボタン反応を受け付けない（コメントは別扱いで残す）。
          // オフラインキューに溜まっていた反応が後から届いても記録されない
          if (kind !== 'comment' && !s.reactionsEnabled) return cb({ ok: false });
          if (
            kind !== 'comment' &&
            !s.reactionButtons.some((b) => b.key === kind)
          ) {
            return cb({ ok: false });
          }
          const pid = socket.data.participantId!;
          const rec = await recordReaction(
            s,
            { id: pid, displayName: socket.data.participantName! },
            sanitized
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
                  typeof sanitized.slideId === 'string'
                    ? sanitized.slideId
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

    // 字幕の履歴。開いたときだけ取りに来るので、常時配らない
    socket.on('get_captions', async (cb) => {
      try {
        cb({ lines: await captionHistory(s) });
      } catch (err) {
        app.log.error(err);
        cb({ lines: [] });
      }
    });

    socket.on('disconnect', async () => {
      if (s.status !== 'ended') {
        updateTelemetry(s, (m) => {
          m.disconnects += 1;
        });
      }
      // ここに来る時点で部屋からは外れているので、そのまま数え直せばよい
      sendAvFormats();
      sendAudioFormats();
      // 端末を閉じた生徒のぶんで音声認識を回し続けない
      if (dropCaptionWant(s, socket.id)) broadcastCaptionUse();
      // 映像を送っていた先生が抜けたら、カメラは止まったものとして扱う。
      // 先生がページを読み込み直しただけでも送信は途切れるので、
      // 教室モニターに止まった絵を映し続けさせない
      if (s.cameraSocketId === socket.id) {
        if (s.telemetryCameraStartedAt !== null) {
          const activeMs = Math.max(0, Date.now() - s.telemetryCameraStartedAt);
          s.telemetryCameraStartedAt = null;
          updateTelemetry(s, (m) => {
            m.video.activeMs += activeMs;
          });
        }
        s.cameraOn = false;
        s.cameraSocketId = null;
        s.avStreams.clear();
        if (s.screenLayout === 'video') s.screenLayout = 'slide';
        io.to(room).emit('av_state', avState());
      }
      broadcastParticipantCount(io, room, teacherRoom);
      broadcastScreenCount(io, room, teacherRoom);
      if (socket.data.participantId) {
        s.composing.delete(socket.data.participantId);
        await touchParticipants([socket.data.participantId]).catch(() => {});
      }
      if (socket.data.role === 'student') {
        if (socket.data.participantId) {
          sendParticipantChange(
            io,
            s,
            teacherRoom,
            { id: socket.data.participantId, displayName: socket.data.participantName ?? '' },
            false
          );
        }
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
  if (s.videoClosedBy.has(participantId)) return false; // 本人が閉じている
  return s.videoToStudents && effectiveAudio(s, participantId) === 'on';
}

/**
 * 生徒それぞれに音声の可否を通知し、音声・映像の配信先も現在の設定に合わせ直す。
 * 教室で受けている（ミュートの）生徒には音声も映像も送らないので通信量を使わない。
 * 音声の設定を変えると両方の対象が変わるため、常にまとめて更新する。
 */
async function syncStudentAv(
  io: TypedServer,
  s: LiveSession,
  room: string
): Promise<void> {
  const sockets = await io.in(room).fetchSockets();
  for (const sock of sockets) {
    const pid = sock.data.participantId;
    if (sock.data.role !== 'student' || !pid) continue;
    sock.emit('audio_permission', { audio: effectiveAudio(s, pid) });

    const wantsAudio = shouldReceiveAudio(s, pid);
    const audioFormat = audioFormatFor(sock.data.audioCanPlay);
    const audioRoom = audioRoomOf(room, audioFormat);
    if (wantsAudio && !sock.rooms.has(audioRoom)) {
      sock.join(audioRoom);
      const localSocket = io.sockets.sockets.get(sock.id);
      if (localSocket) noteAudioReceiver(s, localSocket, audioFormat);
      // 途中から音声を受け取り始める端末にはデコーダ初期化用のヘッダが要る
      const stream = s.audioStreams.get(audioFormat);
      if (stream && s.status === 'live') {
        sock.emit('audio_init', toArrayBuffer(stream.init), stream.seq, stream.mime);
        if (localSocket) noteAudioStarted(s, localSocket);
      }
    } else if (!wantsAudio && sock.rooms.has(audioRoom)) {
      sock.leave(audioRoom);
      const localSocket = io.sockets.sockets.get(sock.id);
      if (localSocket) {
        localSocket.data.telemetryAudioStalled = false;
        localSocket.data.telemetryAudioWaitingAt = undefined;
      }
    }

    const wantsVideo = shouldReceiveVideo(s, pid);
    const avRoom = avRoomOf(room, videoFormatFor(sock.data.videoCanPlay));
    if (wantsVideo && !sock.rooms.has(avRoom)) {
      sock.join(avRoom);
      const localSocket = io.sockets.sockets.get(sock.id);
      if (localSocket) noteVideoReceiver(s, localSocket, videoFormatFor(sock.data.videoCanPlay));
      const stream = s.avStreams.get(videoFormatFor(sock.data.videoCanPlay));
      if (stream && s.cameraOn) {
        sock.emit('av_init', toArrayBuffer(stream.init), stream.seq, stream.mime);
      }
    } else if (!wantsVideo && sock.rooms.has(avRoom)) {
      sock.leave(avRoom);
    }
  }

  // 映像を受け取る生徒が増減すると、必要な形式も変わる
  const formats = VIDEO_FORMATS.filter(
    (f) => (io.sockets.adapter.rooms.get(avRoomOf(room, f))?.size ?? 0) > 0
  );
  io.to(`${room}:teacher`).emit('av_formats', { formats });

  // 音声を受け取る生徒の設定変更でも、先生が動かす録音器の組を更新する
  const audioFormats = AUDIO_FORMATS.filter(
    (f) => (io.sockets.adapter.rooms.get(audioRoomOf(room, f))?.size ?? 0) > 0
  );
  io.to(`${room}:teacher`).emit('audio_formats', { formats: audioFormats });
}

/**
 * 生徒の人数。**先生にだけ送る。**
 *
 * 以前は授業のルーム全体へ送っていたが、この数を使うのは先生画面だけで、
 * 生徒側は受け取って捨てていた。1人入るたびに全員へ配ることになるので、
 * 一斉入室では人数の二乗のメッセージが飛んでいた。
 */
function broadcastParticipantCount(io: TypedServer, room: string, teacherRoom: string): void {
  io.to(teacherRoom).emit('participant_count', roomSize(io, studentRoomOf(room)));
}

/** 教室モニターが何台つながっているか（0なら投影されていないと先生が気づける） */
function broadcastScreenCount(io: TypedServer, room: string, teacherRoom: string): void {
  io.to(teacherRoom).emit('screen_count', roomSize(io, screenRoomOf(room)));
}

/**
 * 参加者1人ぶんの変化だけを先生へ送る（入室・退室）。
 *
 * 全件を送る broadcastParticipants() と違い、**DBもソケット一覧も見ない**。
 * 名前も設定も、いま扱っているソケットとメモリ上の授業から分かるため。
 * 入退室のたびに全件を作り直すと人数の二乗で効くので、ここは1人ぶんに絞る。
 */
function sendParticipantChange(
  io: TypedServer,
  s: LiveSession,
  teacherRoom: string,
  participant: { id: string; displayName: string },
  online: boolean
): void {
  io.to(teacherRoom).emit('participant_changed', {
    id: participant.id,
    displayName: participant.displayName,
    audio: effectiveAudio(s, participant.id),
    overridden: s.audioOverrides.has(participant.id),
    online,
  });
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
