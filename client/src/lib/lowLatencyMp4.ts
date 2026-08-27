/**
 * MP4を自前で組み立てて配信する（WebCodecs）。
 *
 * **なぜ MediaRecorder ではないのか**: ChromeのMediaRecorderはMP4だと
 * キーフレームの区切りでしか断片を吐かず、`timeslice` に500msを渡しても
 * 実際には約4.1秒に1回しかデータが出てこない（キーフレーム間隔が約100フレーム固定で、
 * フレームレートに反比例することを実測で確認）。総遅延にすると約5.3秒で、
 * 教室で使うには遅すぎる。WebCodecsなら**キーフレームを自分で打てる**ので、
 * 0.5秒ごとに断片を切れる。
 *
 * WebMにこの問題は無いので、この経路は**MP4が必要なとき（Safari・iPad・Mac・
 * テレビ内蔵ブラウザが受け手にいるとき）だけ**使う。
 *
 * 送信側はChrome・Edge限定（WebCodecsと MediaStreamTrackProcessor が要る）。
 * 使えない環境や途中で失敗したときは MediaRecorder に戻す（`onFailure`）。
 */

/** 断片の切れ目。キーフレームの間隔がそのまま受け手の遅延の下限になる */
const KEYFRAME_MS = 500;
/** WebCodecsのAACが受け付けるビットレートは決まった値のみ（実測: 96k/128k/160k/192k） */
const AUDIO_BITRATE = 96_000;
/** 符号化が詰まったときに捨てる枚数の閾値。溜めると遅延がそのまま伸びる */
const MAX_QUEUE = 2;

/**
 * H.264のレベルは解像度ごとに上限がある（3.0では1280x720を通せない）。
 * 対応の広い constrained baseline から順に、実際に通るものを選ぶ
 */
const AVC_CANDIDATES = ['avc1.42E01F', 'avc1.42E028', 'avc1.4D001F', 'avc1.640028'];

type TrackProcessorCtor = new <T>(init: { track: MediaStreamTrack }) => {
  readable: ReadableStream<T>;
};

function trackProcessorCtor(): TrackProcessorCtor | null {
  const w = window as unknown as { MediaStreamTrackProcessor?: TrackProcessorCtor };
  return w.MediaStreamTrackProcessor ?? null;
}

/** この端末でこの経路を使えるか（使えなければ MediaRecorder に任せる） */
export function lowLatencyMp4Supported(): boolean {
  return (
    typeof VideoEncoder !== 'undefined' &&
    typeof AudioEncoder !== 'undefined' &&
    typeof VideoFrame !== 'undefined' &&
    trackProcessorCtor() !== null
  );
}

async function pickAvcCodec(
  width: number,
  height: number,
  framerate: number,
  bitrate: number
): Promise<string | null> {
  for (const codec of AVC_CANDIDATES) {
    try {
      const r = await VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
        bitrate,
        framerate,
        latencyMode: 'realtime',
        avc: { format: 'avc' },
      });
      if (r.supported) return r.config?.codec ?? codec;
    } catch {
      /* この候補が駄目なだけ。次を試す */
    }
  }
  return null;
}

/**
 * muxerが書き出すバイト列を、受け手が扱える単位に切り分ける。
 *
 * MP4は [4バイトの長さ][4バイトの種類][中身] の箱が並んだ形をしている。
 * ftyp+moov が先頭（＝デコーダ初期化用のヘッダ）、そのあとは moof+mdat の対が
 * 断片ひとつ分。muxerがどう書き込みを分割してくるかに依存しないよう、
 * 箱の境目は自分で数える。
 */
class BoxSplitter {
  private buf = new Uint8Array(0);
  private initParts: Uint8Array[] = [];
  private initSent = false;
  private pendingMoof: Uint8Array | null = null;
  /** 次に来るはずの書き込み位置。ここから外れたら前に戻って書き直している */
  private nextPos = 0;

  constructor(
    private onSegment: (bytes: Uint8Array, isInit: boolean) => void,
    private onRewrite: () => void
  ) {}

  /**
   * muxerからの書き込み。position は先頭からの通し位置。
   *
   * 断片化MP4は前へ追記していくだけなので、位置が飛んだり戻ったりしたら
   * この切り分け方では正しく組み立てられない。壊れたものを流すより止める
   */
  push(data: Uint8Array, position: number): void {
    if (position !== this.nextPos) {
      this.onRewrite();
      return;
    }
    this.nextPos += data.length;
    const next = new Uint8Array(this.buf.length + data.length);
    next.set(this.buf);
    next.set(data, this.buf.length);
    this.buf = next;
    this.drain();
  }

  private drain(): void {
    for (;;) {
      if (this.buf.length < 8) return;
      const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
      const size = view.getUint32(0);
      // 拡張サイズ(1)や末尾まで(0)はこのmuxerでは出ないが、出たら扱えないので止める
      if (size < 8 || size > this.buf.length) return;
      const type = String.fromCharCode(this.buf[4], this.buf[5], this.buf[6], this.buf[7]);
      const box = this.buf.slice(0, size);
      this.buf = this.buf.slice(size);

      if (!this.initSent && (type === 'ftyp' || type === 'moov')) {
        this.initParts.push(box);
        // moov まで揃えばヘッダとして送れる
        if (type === 'moov') {
          this.onSegment(concat(this.initParts), true);
          this.initSent = true;
          this.initParts = [];
        }
        continue;
      }
      if (type === 'moof') {
        this.pendingMoof = box;
        continue;
      }
      if (type === 'mdat' && this.pendingMoof) {
        this.onSegment(concat([this.pendingMoof, box]), false);
        this.pendingMoof = null;
        continue;
      }
      // free / mfra などは受け手に要らない
    }
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export type LowLatencyMp4 = { stop: () => void };

type Options = {
  stream: MediaStream;
  bitrate: number;
  /** 断片ひとつ分。先頭のヘッダは isInit=true で来る */
  onSegment: (bytes: Uint8Array, mime: string, isInit: boolean) => void;
  /** 途中で符号化に失敗したとき。呼び出し側は MediaRecorder に戻す */
  onFailure: () => void;
};

/**
 * 配信を始める。使えない環境・設定できない環境では null を返すので、
 * 呼び出し側は MediaRecorder に落とすこと。
 */
export async function startLowLatencyMp4(opts: Options): Promise<LowLatencyMp4 | null> {
  const { stream, bitrate, onSegment, onFailure } = opts;
  const Processor = trackProcessorCtor();
  if (!Processor || !lowLatencyMp4Supported()) return null;

  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) return null;
  const audioTrack = stream.getAudioTracks()[0] ?? null;

  /**
   * 映像と音声のタイムスタンプは**別の時計**で刻まれている。
   * （実測では映像が342秒、音声が8,959秒を指していた。2時間以上の開き）
   * そのままMP4に入れると、MSEが2つのトラックの重なりを取れず再生が止まる。
   *
   * そこで各トラックの最初の1枚が「届いた実時刻」を基準にして、共通の時計へ移す。
   * 相対的なずれ（＝口の動きと声のずれ）は実時刻で測った分だけ保たれる
   */
  const startedAt = performance.now();
  const offsets: { v?: number; a?: number } = {};
  const anchor = (kind: 'v' | 'a', ts: number, at = performance.now()): void => {
    if (offsets[kind] === undefined) offsets[kind] = Math.round((at - startedAt) * 1000) - ts;
  };
  const commonTime = (kind: 'v' | 'a', ts: number): number => Math.max(0, ts + (offsets[kind] ?? 0));

  const settings = videoTrack.getSettings();
  const width = settings.width ?? 1280;
  const height = settings.height ?? 720;
  // frameRate を 0 で申告してくる環境がある（そのまま渡すと設定が通らない）。
  // ここは符号化器へのヒントなので、分からないときは想定値でよい
  const framerate = Math.round(settings.frameRate || 0) || 24;

  const videoCodec = await pickAvcCodec(width, height, framerate, bitrate);
  if (!videoCodec) return null;

  let stopped = false;
  const stopFns: (() => void)[] = [];
  const fail = () => {
    if (stopped) return;
    stop();
    onFailure();
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const f of stopFns) {
      try {
        f();
      } catch {
        /* 片付けの失敗は無視してよい */
      }
    }
  };

  try {
    // 音声の形式はトラックの申告ではなく実物から取る（申告が空の端末があるため）
    let audioConfig: { sampleRate: number; numberOfChannels: number } | null = null;
    let audioReader: ReadableStreamDefaultReader<AudioData> | null = null;
    let firstAudio: AudioData | null = null;
    if (audioTrack) {
      audioReader = new Processor<AudioData>({ track: audioTrack }).readable.getReader();
      const first = await withTimeout(audioReader.read(), 2000);
      if (first && !first.done && first.value) {
        firstAudio = first.value;
        // 届いた瞬間を基準にする（この後の準備にかかる時間をずれに含めない）
        anchor('a', firstAudio.timestamp);
        audioConfig = {
          sampleRate: firstAudio.sampleRate,
          numberOfChannels: firstAudio.numberOfChannels,
        };
      } else {
        // 映像に音声トラックがあると受け手は別音声をミュートする。
        // ここで映像だけのMP4を続けると完全な無音になるため、従来方式へ戻す。
        await audioReader.cancel().catch(() => {});
        return null;
      }
    }
    if (stopped) return null;

    // muxerはここで初めて読み込む。生徒・教室モニターの初回読み込みに
    // 含めないため（映像を送るのは先生だけで、しかもMP4が要るときだけ）
    const { Muxer, StreamTarget } = await import('mp4-muxer');

    let mime = '';
    const splitter = new BoxSplitter(
      (bytes, isInit) => {
        if (!stopped && mime) onSegment(bytes, mime, isInit);
      },
      fail
    );

    const muxer = new Muxer({
      target: new StreamTarget({
        // 位置つきで受ける（引数を1つだけにするとmuxerが拒否する）
        onData: (data, position) => splitter.push(data, position),
      }),
      video: { codec: 'avc', width, height },
      ...(audioConfig
        ? {
            audio: {
              codec: 'aac',
              numberOfChannels: audioConfig.numberOfChannels,
              sampleRate: audioConfig.sampleRate,
            },
          }
        : {}),
      fastStart: 'fragmented',
      // 断片の長さは自分で打つキーフレームで決める。muxer側の下限（既定1秒）を
      // 残すと、キーフレーム2枚分が1つの断片にまとめられて遅延が倍になる
      minFragmentDuration: 0,
      // 映像と音声の時刻は同じ時計から来るので、そろえてから0起点にする
      firstTimestampBehavior: 'cross-track-offset',
    });

    // ---- 映像 ----
    const videoEncoder = new VideoEncoder({
      output: (chunk, meta) => {
        if (stopped) return;
        if (meta?.decoderConfig?.codec) {
          mime = `video/mp4;codecs="${meta.decoderConfig.codec}${audioConfig ? ',mp4a.40.2' : ''}"`;
        }
        muxer.addVideoChunk(chunk, meta, commonTime('v', chunk.timestamp));
      },
      error: fail,
    });
    videoEncoder.configure({
      codec: videoCodec,
      width,
      height,
      bitrate,
      framerate,
      latencyMode: 'realtime',
      avc: { format: 'avc' },
    });
    stopFns.push(() => videoEncoder.state !== 'closed' && videoEncoder.close());

    // ---- 音声 ----
    let audioEncoder: AudioEncoder | null = null;
    if (audioConfig) {
      audioEncoder = new AudioEncoder({
        output: (chunk, meta) => {
          if (!stopped) muxer.addAudioChunk(chunk, meta, commonTime('a', chunk.timestamp));
        },
        error: fail,
      });
      audioEncoder.configure({
        codec: 'mp4a.40.2',
        sampleRate: audioConfig.sampleRate,
        numberOfChannels: audioConfig.numberOfChannels,
        bitrate: AUDIO_BITRATE,
      });
      const enc = audioEncoder;
      stopFns.push(() => enc.state !== 'closed' && enc.close());
    }

    // ---- 映像を送り続ける ----
    const videoReader = new Processor<VideoFrame>({ track: videoTrack }).readable.getReader();
    stopFns.push(() => void videoReader.cancel().catch(() => {}));
    let lastKeyAt = 0;
    void (async () => {
      for (;;) {
        const { done, value } = await videoReader.read();
        if (done || stopped) {
          value?.close();
          return;
        }
        const frame = value;
        // 詰まっているときは捨てる。溜めても遅れが伸びるだけで、
        // 授業では「少しカクつく」より「ずっと遅れる」ほうが困る
        if (videoEncoder.encodeQueueSize > MAX_QUEUE) {
          frame.close();
          continue;
        }
        const now = performance.now();
        anchor('v', frame.timestamp, now);
        const keyFrame = now - lastKeyAt >= KEYFRAME_MS;
        if (keyFrame) lastKeyAt = now;
        try {
          videoEncoder.encode(frame, { keyFrame });
        } catch {
          frame.close();
          fail();
          return;
        }
        frame.close();
      }
    })();

    // ---- 音声を送り続ける ----
    if (audioEncoder && audioReader) {
      const enc = audioEncoder;
      const reader = audioReader;
      stopFns.push(() => void reader.cancel().catch(() => {}));
      if (firstAudio) {
        enc.encode(firstAudio);
        firstAudio.close();
      }
      void (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || stopped) {
            value?.close();
            return;
          }
          try {
            enc.encode(value);
          } catch {
            value.close();
            fail();
            return;
          }
          value.close();
        }
      })();
    }

    return { stop };
  } catch {
    stop();
    return null;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}
