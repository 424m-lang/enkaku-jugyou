import type { AppSocket } from './socket';
import { LiveMediaPlayer } from './liveMedia';

const MIME = 'audio/webm;codecs=opus';
const CHUNK_MS = 500;

/**
 * 先生側: マイク音声をOpusで低遅延エンコードし、500msごとのチャンクとして送信する。
 * MediaRecorderはソケット切断中も動き続け、Socket.IOのクライアントバッファに
 * 溜まったチャンクは再接続時にまとめて送信される（録音の欠落を防ぐ）。
 */
export async function startAudioBroadcast(socket: AppSocket): Promise<{ stop: () => void }> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
  const recorder = new MediaRecorder(stream, {
    mimeType: MediaRecorder.isTypeSupported(MIME) ? MIME : undefined,
    audioBitsPerSecond: 48_000, // 音声主体の授業に十分な品質と帯域のバランス
  });
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      void e.data.arrayBuffer().then((buf) => socket.emit('audio_chunk', buf));
    }
  };
  recorder.start(CHUNK_MS);
  return {
    stop() {
      if (recorder.state !== 'inactive') recorder.stop();
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

/** 生徒・大画面側: 音声のみのライブストリームを再生する */
export class LiveAudioPlayer extends LiveMediaPlayer {
  constructor(el: HTMLAudioElement) {
    super(el, MIME);
  }
}
