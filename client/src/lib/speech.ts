/**
 * ブラウザ音声認識（Web Speech API）で字幕を作る。先生の端末でだけ動く。
 *
 * サーバ側の文字起こし（Whisper）は用語の精度が高いが10秒以上遅れる。
 * 教室の字幕は5秒が許容ラインとされており、耳の不自由な生徒が授業に追従するには
 * それでは足りないため、ライブ字幕はこちらを使う。用語の正しい版は履歴側で
 * Whisperに差し替える。
 *
 * 制約: Chrome・Edge が前提。Safariは不安定、Firefoxは非対応。
 * Chromeの実装は音声をGoogleのサーバへ送るため、その点は利用者に伝えること。
 */

type SpeechResultAlternative = { transcript: string };
type SpeechResult = { isFinal: boolean; 0: SpeechResultAlternative; length: number };
type SpeechResultList = { length: number; [i: number]: SpeechResult };
type SpeechEvent = { resultIndex: number; results: SpeechResultList };
type SpeechErrorEvent = { error: string };

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: SpeechErrorEvent) => void) | null;
};

type RecognitionCtor = new () => Recognition;

/** 暫定結果は変化のたびに来るので、送る頻度を抑える */
const INTERIM_MIN_INTERVAL_MS = 250;
/** 認識は無音などで勝手に終わるので、止めたのでなければ入れ直す */
const RESTART_DELAY_MS = 400;
/** 権限拒否など、繰り返しても直らない種類のエラー */
const FATAL_ERRORS = new Set(['not-allowed', 'service-not-allowed']);

function ctor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** この端末で字幕を作れるか */
export function captionsSupported(): boolean {
  return ctor() !== null;
}

export type CaptionSource = {
  stop(): void;
};

export function startCaptions(opts: {
  /** final=false は認識途中。同じ発話の確定版が後から来る */
  onText: (text: string, final: boolean) => void;
  /** 権限拒否などで継続できなくなったとき */
  onFatal?: (error: string) => void;
}): CaptionSource | null {
  const Ctor = ctor();
  if (!Ctor) return null;

  let stopped = false;
  let lastInterimAt = 0;
  let rec: Recognition | null = null;

  const build = (): Recognition => {
    const r = new Ctor();
    r.lang = 'ja-JP';
    r.continuous = true;
    r.interimResults = true;

    r.onresult = (e) => {
      // resultIndex 以降が今回更新された分
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        const text = result[0]?.transcript?.trim();
        if (!text) continue;
        if (result.isFinal) {
          opts.onText(text, true);
          lastInterimAt = 0; // 確定を出したので、次の暫定はすぐ送ってよい
        } else {
          const now = Date.now();
          if (now - lastInterimAt < INTERIM_MIN_INTERVAL_MS) continue;
          lastInterimAt = now;
          opts.onText(text, false);
        }
      }
    };

    r.onerror = (e) => {
      if (FATAL_ERRORS.has(e.error)) {
        stopped = true;
        opts.onFatal?.(e.error);
      }
      // no-speech / aborted / network は onend の再開に任せる
    };

    r.onend = () => {
      if (stopped) return;
      // 無音が続くと勝手に終わるので、授業中は入れ直し続ける
      setTimeout(() => {
        if (stopped) return;
        try {
          rec = build();
          rec.start();
        } catch {
          /* 直後の再開が拒否されることがある。次のonendで再試行される */
        }
      }, RESTART_DELAY_MS);
    };

    return r;
  };

  try {
    rec = build();
    rec.start();
  } catch {
    return null;
  }

  return {
    stop() {
      stopped = true;
      try {
        rec?.abort();
      } catch {
        /* ignore */
      }
      rec = null;
    },
  };
}
