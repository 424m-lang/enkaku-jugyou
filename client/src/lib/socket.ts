import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@shared';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * 授業ルームへのSocket.IO接続。
 * 切断時は自動再接続し、再接続時にはサーバから lesson_state スナップショットが
 * 再送されるため、クライアントは常に最新状態へ復帰できる。
 */
export function connectLessonSocket(lessonId: string): AppSocket {
  const participantToken = sessionStorage.getItem('participantToken') ?? undefined;
  return io({
    auth: { lessonId, participantToken },
    withCredentials: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  });
}
