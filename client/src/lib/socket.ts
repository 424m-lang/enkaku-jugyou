import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@shared';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * 授業ルームへのSocket.IO接続。
 * 切断時は自動再接続し、再接続時にはサーバから lesson_state スナップショットが
 * 再送されるため、クライアントは常に最新状態へ復帰できる。
 */
export function connectLessonSocket(lessonId: string, screenToken?: string): AppSocket {
  // 教室の大画面はURLのトークンだけで表示専用の接続をする（先生のログイン不要）
  const participantToken = screenToken
    ? undefined
    : (sessionStorage.getItem('participantToken') ?? undefined);
  return io({
    auth: { lessonId, participantToken, screenToken },
    withCredentials: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  });
}
