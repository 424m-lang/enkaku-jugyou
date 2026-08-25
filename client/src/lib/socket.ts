import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@shared';
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
 * MSEの対応はブラウザによって割れる（SafariはWebMを一切再生できない）ので、
 * 先生の端末が「誰に何を送ればよいか」を決めるための材料になる。
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

export function connectLessonSocket(lessonId: string, screenToken?: string): AppSocket {
  // 教室モニターはURLのトークンだけで表示専用の接続をする（先生のログイン不要）
  const participantToken = screenToken
    ? undefined
    : (readStored('session', 'participantToken') ?? undefined);
  return io({
    // 再生できる映像形式は接続時に申告する。イベントで後から送ると、
    // サーバが「まだ分からない相手」を抱えた一瞬ができてしまう。
    // 認証情報と一緒なら再接続時にも自動で送り直される
    auth: {
      lessonId,
      participantToken,
      screenToken,
      canPlay: { video: videoCanPlay(), audio: audioCanPlay() },
    },
    withCredentials: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  });
}
