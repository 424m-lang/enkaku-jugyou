import { io, type Socket } from 'socket.io-client';
import type { ClientEnvironment, ClientToServerEvents, ServerToClientEvents } from '@shared';
import { canPlayMime } from './liveMedia';
import { readStored } from './storage';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * 授業ルームへのSocket.IO接続。
 * 切断時は自動再接続し、再接続時にはサーバから lesson_state スナップショットが
 * 再送されるため、クライアントは常に最新状態へ復帰できる。
 */
/**
 * この端末が再生できる映像形式。
 * MSEの対応形式は端末とブラウザによって異なるため、ブラウザ名ではなく
 * 実際の対応形式を先生の端末が配信形式を決めるための材料にする。
 */
function videoCanPlay() {
  return {
    webm: canPlayMime('video/webm;codecs="vp8,opus"'),
    mp4: canPlayMime('video/mp4;codecs="avc1.42E01E,mp4a.40.2"'),
  };
}

/**
 * この端末がライブ音声として再生できる形式。
 * 通常の <audio> の対応ではなく、実際の配信で使うMSE/MMSの対応を調べる。
 */
function audioCanPlay() {
  return {
    webm: canPlayMime('audio/webm;codecs=opus'),
    mp4: canPlayMime('audio/mp4;codecs=mp4a.40.2'),
  };
}

const TELEMETRY_SESSION_KEY = 'lessonTelemetrySession';

/**
 * 同じタブの再接続だけを見分ける一時乱数。sessionStorageなのでタブを閉じれば消え、
 * 氏名・参加者ID・端末IDの代わりにはならない。
 */
function telemetrySessionId(): string {
  try {
    const stored = window.sessionStorage.getItem(TELEMETRY_SESSION_KEY);
    if (stored) return stored;
    const created = crypto.randomUUID();
    window.sessionStorage.setItem(TELEMETRY_SESSION_KEY, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

/** 生のUser-Agentを送らず、この場で授業改善に必要な大分類へ丸める */
function clientEnvironment(): ClientEnvironment {
  const ua = navigator.userAgent;
  const ipadOs = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  const platform: ClientEnvironment['platform'] =
    /iPhone|iPad|iPod/i.test(ua) || ipadOs
      ? 'apple-mobile'
      : /Android/i.test(ua)
        ? 'android'
        : /Windows|Macintosh|Linux|CrOS/i.test(ua)
          ? 'desktop'
          : 'other';
  const browser: ClientEnvironment['browser'] = /Firefox|FxiOS/i.test(ua)
    ? 'firefox'
    : /Edg|OPR|Chrome|Chromium|CriOS/i.test(ua)
      ? 'chromium'
      : /Safari/i.test(ua)
        ? 'safari'
        : 'other';
  return { platform, browser };
}

export function connectLessonSocket(lessonId: string, screenToken?: string): AppSocket {
  // 教室モニターはURLのトークンだけで表示専用の接続をする（先生のログイン不要）
  const participantToken = screenToken
    ? undefined
    : (readStored('session', 'participantToken') ?? undefined);
  const socket: AppSocket = io({
    // 再生できる映像形式は接続時に申告する。イベントで後から送ると、
    // サーバが「まだ分からない相手」を抱えた一瞬ができてしまう。
    // 認証情報と一緒なら再接続時にも自動で送り直される
    auth: {
      lessonId,
      participantToken,
      screenToken,
      canPlay: { video: videoCanPlay(), audio: audioCanPlay() },
      telemetry: { sessionId: telemetrySessionId(), environment: clientEnvironment() },
    },
    withCredentials: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  });
  let connectedOnce = false;
  socket.on('connect', () => {
    if (connectedOnce) socket.emit('telemetry', { type: 'reconnect' });
    connectedOnce = true;
  });
  return socket;
}
