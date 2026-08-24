import type { AppSocket } from './socket';
import { LiveMediaPlayer } from './liveMedia';

/**
 * 先生のカメラ映像（顔・手元の実演）を教室の大画面へ届けるための配信。
 *
 * 音声を別ストリームにすると口の動きと声が0.5〜1秒ずれてしまうため、
 * 映像と音声を1本のストリームにまとめて送る。文字起こし用の音声のみの配信は
 * これとは別に動き続けており、こちらは録音・保存もしない（ライブ限定）。
 */

// MSEで再生できる組み合わせを優先順に試す（VP8は対応が最も広い）
const VIDEO_MIME_CANDIDATES = [
  'video/webm;codecs="vp8,opus"',
  'video/webm;codecs="vp9,opus"',
  'video/webm',
];

const CHUNK_MS = 500;
/** 授業の実演が見える範囲で通信量を抑える（720pの動きの少ない映像を想定） */
const VIDEO_BITS_PER_SECOND = 900_000;

/** 送受信の両方で使える形式。無ければこの環境では映像を扱えない */
export function supportedVideoMime(): string | null {
  for (const mime of VIDEO_MIME_CANDIDATES) {
    const canSend = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime);
    const canPlay = typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mime);
    if (canSend && canPlay) return mime;
  }
  return null;
}

/** 再生だけできれば良い側（大画面・生徒）の判定 */
export function playableVideoMime(): string | null {
  for (const mime of VIDEO_MIME_CANDIDATES) {
    if (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mime)) return mime;
  }
  return null;
}

export type CameraOption = { deviceId: string; label: string };

/**
 * 使えるカメラの一覧。
 * ラベルはカメラの許可を一度得るまで空になるため、その場合は通し番号で表示する。
 */
export async function listCameras(): Promise<CameraOption[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `カメラ ${i + 1}` }));
}

export type CameraBroadcast = {
  stop: () => void;
  /** 先生の手元に自分の映像を映すためのストリーム */
  stream: MediaStream;
  /**
   * このストリームに音声が入っているか。
   * マイクが使えないときは映像だけで配信を続けるが、その場合は受け手が
   * 音声のみのストリームを鳴らし続ける必要があるので、状態として伝える。
   */
  hasAudio: boolean;
};

export async function startCameraBroadcast(
  socket: AppSocket,
  deviceId?: string
): Promise<CameraBroadcast> {
  const mime = supportedVideoMime();
  if (!mime) throw new Error('この端末では映像の配信に対応していません');

  const video: MediaTrackConstraints = {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 24 },
  };

  let stream: MediaStream;
  try {
    // 大画面はこの1本から音を鳴らすので、映像と同じストリームに音声も入れる
    // （別ストリームにすると口の動きと声がずれる）
    stream = await navigator.mediaDevices.getUserMedia({
      video,
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
  } catch {
    // マイクが使えない環境でも映像だけは見せられるようにする
    stream = await navigator.mediaDevices.getUserMedia({ video });
  }
  const hasAudio = stream.getAudioTracks().length > 0;

  const recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
    audioBitsPerSecond: 48_000,
  });
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      void e.data.arrayBuffer().then((buf) => socket.emit('av_chunk', buf));
    }
  };
  recorder.start(CHUNK_MS);

  return {
    stream,
    hasAudio,
    stop() {
      if (recorder.state !== 'inactive') recorder.stop();
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

/** 大画面・遠隔の生徒側: カメラ映像（音声込み）を再生する */
export class LiveVideoPlayer extends LiveMediaPlayer {
  constructor(el: HTMLVideoElement, mime: string) {
    super(el, mime);
  }
}
