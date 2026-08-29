import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { LiveMediaPlayer, canPlayMime, getMediaSourceCtor } from '../lib/liveMedia';
import { AUDIO_BITS_PER_SECOND, supportedAudioMime } from '../lib/audio';
import { supportedVideoMime } from '../lib/camera';

/**
 * 端末チェックページ（/check）。ログインと授業コードは不要。
 *
 * 同じ端末でも用途によって必要な条件が変わる（教室のモニターには音が要るが、
 * 教室で受ける生徒の端末には要らない）ため、まず役割を選んでから判定する。
 *
 * 確認する項目:
 * 1. 通信が通るか（学校のフィルタリングでWebSocketが塞がれていないか）
 * 2. 端末の受信・送信速度から、各機能を使用できる目安
 * 3. 先生が送るOpus/AACのどちらかをこの端末がライブ再生できるか
 * 4. 実際にスピーカーから音が出るか（アプリ・OS・モニター本体の3段の音量）
 */

/** 実測にかける秒数。短すぎると無音とのばらつきを拾う */
const MEASURE_SEC = 10;
/** 目安に使う1コマの長さ（分） */
const LESSON_MIN = 50;
/**
 * ギガの上限を超えたあとの速度制限。実際の音声量がこの値の6割を超える場合は、
 * 書き込みと通信方式に使える余裕が少ないことを先生へ知らせる
 */
const THROTTLED_KBPS = 128;
/** 回線測定で送受信するデータ量。サーバ側の上限と対応させる */
const SPEED_TEST_BYTES = 128 * 1024;
const SPEED_TEST_TIMEOUT_MS = 30_000;

/** 用途別判定に使用する通信速度。公称値に通信方式の上乗せと変動分を含める */
const BASIC_DOWNLOAD_KBPS = 64;
const AUDIO_DOWNLOAD_KBPS = 96;
const VIDEO_DOWNLOAD_KBPS = 1_500;
const AUDIO_UPLOAD_KBPS = 96;
const VIDEO_UPLOAD_KBPS = 2_500;

type AudioRate = {
  /** 標準のOpusと、互換用AACを同じマイクで同時に測る */
  opusKbps: number | null;
  aacKbps: number | null;
  /**
   * その行を測るのに**実際に使われた**形式。
   *
   * ブラウザは指定と違う形式を選ぶことがある（isTypeSupported が true を返しても
   * 別形式で録る端末がある）。要求した名前で表示すると、中身はAACなのに
   * 「Opus」と読めてしまい、現地で判断を誤る
   */
  opusMime: string | null;
  aacMime: string | null;
  channels: number | null;
  /** マイクのサンプリング周波数。48000以外だとAACが何も吐かないことがある */
  sampleRate: number | null;
};

/** 実際の形式が、その行が名乗っている形式と食い違っていないか */
function mimeMatches(kind: 'opus' | 'aac', mime: string | null): boolean {
  if (!mime) return true;
  const isMp4 = mime.includes('mp4') || mime.includes('aac');
  return kind === 'aac' ? isMp4 : !isMp4;
}

type State = 'pending' | 'ok' | 'warn' | 'ng' | 'skip';
type Role = 'monitor' | 'student-remote' | 'student-room' | 'teacher';
type SpeedMeasurement = {
  status: 'pending' | 'done' | 'error';
  kbps: number | null;
  error: string;
};

const MARK: Record<State, string> = {
  pending: '…',
  ok: '○',
  warn: '△',
  ng: '×',
  skip: '—',
};

type RoleSpec = {
  label: string;
  hint: string;
  /** 音声を再生する必要があるか（＝形式の対応とスピーカーが必須か） */
  needsPlayback: boolean;
  /** マイクが必要か */
  needsMic: boolean;
  /** 映像を見る立場か（見られなくても授業は成立するので必須ではない） */
  watchesVideo: boolean;
};

const ROLES: Record<Role, RoleSpec> = {
  monitor: {
    label: '教室のモニター',
    hint: '教室に音とスライドを映す端末',
    needsPlayback: true,
    needsMic: false,
    watchesVideo: true,
  },
  'student-remote': {
    label: '生徒の端末（遠隔）',
    hint: '自宅などから1人で受ける',
    needsPlayback: true,
    needsMic: false,
    watchesVideo: true,
  },
  'student-room': {
    label: '生徒の端末（教室）',
    hint: '音は教室のスピーカーから聞く',
    needsPlayback: false,
    needsMic: false,
    watchesVideo: false,
  },
  teacher: {
    label: '先生の端末',
    hint: 'マイクで配信し、必要に応じてカメラも使う',
    needsPlayback: false,
    needsMic: true,
    watchesVideo: false,
  },
};

/** 先生が送ってくる可能性のある形式（audio.ts / camera.ts の候補と対応させること） */
const AUDIO_FORMATS = [
  { mime: 'audio/webm;codecs=opus', label: 'Opus（通信量の少ない標準形式）' },
  { mime: 'audio/mp4;codecs=mp4a.40.2', label: 'AAC（Opus非対応端末向け）' },
];
const VIDEO_FORMATS = [
  { mime: 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"', label: 'H.264' },
  { mime: 'video/webm;codecs="vp8,opus"', label: 'VP8' },
];

function Row({ state, label, detail }: { state: State; label: string; detail?: string }) {
  return (
    <li className={`check-row check-${state}`}>
      <span className="check-mark">{MARK[state]}</span>
      <span className="check-label">
        {label}
        {detail && <span className="check-detail">{detail}</span>}
      </span>
    </li>
  );
}

function formatSpeed(kbps: number): string {
  return kbps >= 1_000 ? `${(kbps / 1_000).toFixed(1)}Mbps` : `${kbps}kbps`;
}

/** 測定値が目安の75%未満なら×、目安未満なら△、目安以上なら○ */
function speedState(measurement: SpeedMeasurement, requiredKbps: number): State {
  if (measurement.status === 'pending') return 'pending';
  if (measurement.status === 'error' || measurement.kbps === null) return 'ng';
  if (measurement.kbps >= requiredKbps) return 'ok';
  return measurement.kbps >= requiredKbps * 0.75 ? 'warn' : 'ng';
}

function speedDetail(measurement: SpeedMeasurement, requiredKbps: number): string {
  if (measurement.status === 'pending') return '測定しています';
  if (measurement.status === 'error') return measurement.error;
  return `測定 ${formatSpeed(measurement.kbps ?? 0)}・必要な目安 ${formatSpeed(requiredKbps)}`;
}

export default function Check() {
  const navigate = useNavigate();
  const location = useLocation();
  // ショートカット（Ctrl+Alt+C）で来た場合だけ、元の画面に戻れるようにする
  const from = (location.state as { from?: string } | null)?.from ?? null;
  const [role, setRole] = useState<Role>('monitor');
  const [health, setHealth] = useState<State>('pending');
  const [polling, setPolling] = useState<State>('pending');
  const [websocket, setWebsocket] = useState<State>('pending');
  const [wsDetail, setWsDetail] = useState('');
  const [toneState, setToneState] = useState<State>('pending');
  const [tonePlaying, setTonePlaying] = useState(false);
  const [toneHow, setToneHow] = useState('');
  const [micState, setMicState] = useState<State>('pending');
  const [micDetail, setMicDetail] = useState('');
  // 実際に何kbps出るかは端末とブラウザで変わる。回線の細い家庭がいる授業では
  // これがそのまま「その生徒に届くかどうか」になるので、現地で測れるようにする
  const [rateBusy, setRateBusy] = useState(0); // 残り秒数（0なら測っていない）
  const [rateResult, setRateResult] = useState<AudioRate | null>(null);
  const [rateError, setRateError] = useState('');
  const [downloadSpeed, setDownloadSpeed] = useState<SpeedMeasurement>({
    status: 'pending',
    kbps: null,
    error: '',
  });
  const [uploadSpeed, setUploadSpeed] = useState<SpeedMeasurement>({
    status: 'pending',
    kbps: null,
    error: '',
  });
  const downloadStartedRef = useRef(false);
  const teacherUploadStartedRef = useRef(false);
  const audioElRef = useRef<HTMLAudioElement>(null);
  const playerRef = useRef<LiveMediaPlayer | null>(null);

  const spec = ROLES[role];
  const hasMse = getMediaSourceCtor() !== null;
  const audioSupport = AUDIO_FORMATS.map((f) => ({ ...f, ok: canPlayMime(f.mime) }));
  const videoSupport = VIDEO_FORMATS.map((f) => ({ ...f, ok: canPlayMime(f.mime) }));
  // どちらか一方を再生できれば、サーバがその端末を対応する形式の部屋へ入れる
  const canPlayLikely = audioSupport.some((f) => f.ok);
  const playbackUnsupported = spec.needsPlayback && (!hasMse || !canPlayLikely);
  const broadcastOpus = supportedAudioMime('webm');
  const broadcastAac = supportedAudioMime('mp4');
  const broadcastVideo = supportedVideoMime();

  // ---- 通信の確認（役割によらず必須なので、開いた時点で走らせる） ----
  useEffect(() => {
    let alive = true;

    void fetch('/api/health')
      .then((r) => alive && setHealth(r.ok ? 'ok' : 'ng'))
      .catch(() => alive && setHealth('ng'));

    // Socket.IOのHTTPポーリング。WebSocketが塞がれていてもこれが通れば授業は成立する
    void fetch('/socket.io/?EIO=4&transport=polling&t=' + Date.now())
      .then((r) => alive && setPolling(r.ok ? 'ok' : 'ng'))
      .catch(() => alive && setPolling('ng'));

    // WebSocketが学校のフィルタリングを通るか。開けた時点で通過が確定する
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    let ws: WebSocket | null = null;
    const fallback = () => {
      setWebsocket('warn');
      setWsDetail('繋がりませんでした（ポーリング方式で動作します）');
    };
    const timer = setTimeout(() => {
      if (!alive || !ws) return;
      if (ws.readyState !== WebSocket.OPEN) {
        fallback();
        ws.close();
      }
    }, 6000);
    try {
      ws = new WebSocket(
        scheme + '://' + window.location.host + '/socket.io/?EIO=4&transport=websocket'
      );
      ws.onopen = () => {
        if (!alive) return;
        clearTimeout(timer);
        setWebsocket('ok');
        ws?.close();
      };
      ws.onerror = () => {
        if (!alive) return;
        clearTimeout(timer);
        fallback();
      };
    } catch {
      setWebsocket('warn');
      setWsDetail('この端末では試せませんでした');
    }

    return () => {
      alive = false;
      clearTimeout(timer);
      ws?.close();
    };
  }, []);

  useEffect(() => () => playerRef.current?.dispose(), []);

  /** サーバから端末へ、固定量の測定データを受信する */
  const measureDownloadSpeed = useCallback(async () => {
    setDownloadSpeed({ status: 'pending', kbps: null, error: '' });
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), SPEED_TEST_TIMEOUT_MS);
    const startedAt = performance.now();
    try {
      const response = await fetch(`/api/check/download?t=${Date.now()}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`サーバが ${response.status} を返しました`);
      const body = await response.arrayBuffer();
      const elapsedMs = Math.max(1, performance.now() - startedAt);
      setDownloadSpeed({
        status: 'done',
        kbps: Math.round((body.byteLength * 8) / elapsedMs),
        error: '',
      });
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === 'AbortError';
      setDownloadSpeed({
        status: 'error',
        kbps: null,
        error: timedOut ? '30秒以内に測定できませんでした' : '受信速度を測定できませんでした',
      });
    } finally {
      window.clearTimeout(timer);
    }
  }, []);

  /** 先生端末からサーバへ、固定量の測定データを送信する */
  const measureUploadSpeed = useCallback(async () => {
    setUploadSpeed({ status: 'pending', kbps: null, error: '' });
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), SPEED_TEST_TIMEOUT_MS);
    const body = new ArrayBuffer(SPEED_TEST_BYTES);
    const startedAt = performance.now();
    try {
      const response = await fetch(`/api/check/upload?t=${Date.now()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body,
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`サーバが ${response.status} を返しました`);
      const elapsedMs = Math.max(1, performance.now() - startedAt);
      setUploadSpeed({
        status: 'done',
        kbps: Math.round((body.byteLength * 8) / elapsedMs),
        error: '',
      });
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === 'AbortError';
      setUploadSpeed({
        status: 'error',
        kbps: null,
        error: timedOut ? '30秒以内に測定できませんでした' : '送信速度を測定できませんでした',
      });
    } finally {
      window.clearTimeout(timer);
    }
  }, []);

  // 受信速度はすべての役割で使用するため、画面を開いた時点で測定する。
  useEffect(() => {
    if (downloadStartedRef.current) return;
    downloadStartedRef.current = true;
    void measureDownloadSpeed();
  }, [measureDownloadSpeed]);

  // 先生を選んだ場合だけ、配信に使用する送信速度も測定する。
  useEffect(() => {
    if (role !== 'teacher' || teacherUploadStartedRef.current) return;
    teacherUploadStartedRef.current = true;
    void measureUploadSpeed();
  }, [measureUploadSpeed, role]);

  /**
   * テスト音を鳴らす。
   * 録音できる端末では、授業と同じ経路（MediaRecorder→MSE）を通して確かめる。
   * 録音できない端末（テレビ内蔵ブラウザなど）でもスピーカーの確認はしたいので、
   * その場合は単純な発振音に切り替える。
   */
  const playTone = useCallback(async () => {
    setTonePlaying(true);
    const el = audioElRef.current;
    const recordMime = supportedAudioMime();

    if (el && recordMime && hasMse && canPlayMime(recordMime)) {
      try {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const dest = ctx.createMediaStreamDestination();
        osc.frequency.value = 440;
        gain.gain.value = 0.25;
        osc.connect(gain);
        gain.connect(dest);
        osc.start();
        const chunks: Blob[] = [];
        const rec = new MediaRecorder(dest.stream, { mimeType: recordMime });
        rec.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data);
        };
        rec.start(400);
        await new Promise((r) => setTimeout(r, 1800));
        rec.stop();
        osc.stop();
        await ctx.close();
        await new Promise((r) => setTimeout(r, 250));

        if (chunks.length >= 2) {
          const bufs: ArrayBuffer[] = [];
          for (const c of chunks) bufs.push(await c.arrayBuffer());
          playerRef.current?.dispose();
          const p = new LiveMediaPlayer(el);
          playerRef.current = p;
          el.volume = 1;
          el.muted = false;
          p.enable();
          p.reset(bufs[0], rec.mimeType || recordMime);
          for (let i = 1; i < bufs.length; i++) p.push(bufs[i]);
          setToneHow('授業と同じ経路（' + (rec.mimeType || recordMime) + '）で再生しました');
          setTimeout(() => setTonePlaying(false), 2500);
          return;
        }
      } catch {
        /* 録音できない環境。下の発振音に切り替える */
      }
    }

    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 440;
      gain.gain.value = 0.25;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      setToneHow('この端末は録音に対応していないため、単純な音でスピーカーだけ確認しています');
      setTimeout(() => {
        osc.stop();
        void ctx.close();
        setTonePlaying(false);
      }, 2000);
    } catch {
      setToneHow('音を鳴らせませんでした');
      setTonePlaying(false);
    }
  }, [hasMse]);

  /**
   * 本番と同じ設定でマイクを録り、実際に出る通信量を測る。
   *
   * 指定した `audioBitsPerSecond` は**そのとおりにならないことがある**
   * （AACは下げ幅に下限がある）。しかも下限は端末とブラウザで変わるので、
   * 推測ではなく現地の実機で測るしかない。
   *
   * 比較用にOpusも同時に録る。差が大きければ、受け手に合わせて形式を
   * 選び分ける価値があると分かる（差が小さければその作業は要らない）。
   */
  const measureRate = useCallback(async () => {
    setRateError('');
    setRateResult(null);
    let stream: MediaStream;
    try {
      // 本番の startAudioBroadcast と同じ制約で取る
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
    } catch (e) {
      setRateError(e instanceof Error ? e.message : 'マイクを使えませんでした');
      return;
    }

    const opus = supportedAudioMime('webm');
    const aac = supportedAudioMime('mp4');
    const targets: { key: 'opus' | 'aac'; mime: string }[] = [];
    if (opus) targets.push({ key: 'opus', mime: opus });
    if (aac) targets.push({ key: 'aac', mime: aac });
    if (targets.length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      setRateError('この端末では録音できません');
      return;
    }

    const bytes: Record<string, number> = {};
    const actualMime: Record<string, string> = {};
    const recs = targets.map(({ key, mime }) => {
      const rec = new MediaRecorder(stream, {
        mimeType: mime,
        audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
      });
      bytes[key] = 0;
      rec.ondataavailable = (e) => {
        bytes[key] += e.data.size;
      };
      rec.start(500);
      // start() のあとが確定した値。要求ではなく実物を控える
      actualMime[key] = rec.mimeType || mime;
      return rec;
    });

    for (let left = MEASURE_SEC; left > 0; left--) {
      setRateBusy(left);
      await new Promise((r) => setTimeout(r, 1000));
    }
    setRateBusy(0);
    recs.forEach((r) => r.state !== 'inactive' && r.stop());
    // stop() のあとに最後のチャンクが届くので少し待ってから集計する
    await new Promise((r) => setTimeout(r, 400));
    const st = stream.getAudioTracks()[0]?.getSettings();
    const channels = st?.channelCount ?? null;
    const sampleRate = st?.sampleRate ?? null;
    stream.getTracks().forEach((t) => t.stop());

    const kbps = (n: number) => Math.round((n * 8) / MEASURE_SEC / 1000);
    setRateResult({
      opusKbps: bytes.opus !== undefined ? kbps(bytes.opus) : null,
      aacKbps: bytes.aac !== undefined ? kbps(bytes.aac) : null,
      opusMime: actualMime.opus ?? null,
      aacMime: actualMime.aac ?? null,
      channels,
      sampleRate,
    });
  }, []);

  const checkMic = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setMicState('ok');
      setMicDetail('');
    } catch (e) {
      setMicState('ng');
      setMicDetail(e instanceof Error ? e.message : '許可されませんでした');
    }
  }, []);

  // ---- 役割ごとの合否 ----
  const netOk = health !== 'ng' && polling !== 'ng';
  // 総合判定では、その役割に必須の方向をすべて確認する。
  // 先生は送信だけでなく、PDFや操作画面を受け取るための受信速度も必要になる。
  const requiredSpeedChecks =
    role === 'teacher'
      ? [
          { measurement: downloadSpeed, state: speedState(downloadSpeed, BASIC_DOWNLOAD_KBPS) },
          { measurement: uploadSpeed, state: speedState(uploadSpeed, AUDIO_UPLOAD_KBPS) },
        ]
      : [
          {
            measurement: downloadSpeed,
            state: speedState(
              downloadSpeed,
              spec.needsPlayback ? AUDIO_DOWNLOAD_KBPS : BASIC_DOWNLOAD_KBPS
            ),
          },
        ];
  const canBroadcastAudio = broadcastOpus !== null || broadcastAac !== null;
  let verdict: State;
  let verdictWhy = '';
  if (!netOk) {
    verdict = 'ng';
    verdictWhy = 'サーバに繋がりません。ネットワークかフィルタリングの問題です。';
  } else if (playbackUnsupported) {
    verdict = 'ng';
    verdictWhy = !hasMse
      ? 'このブラウザはライブ音声の再生に対応していません。'
      : '先生が送る音声形式を再生できません。';
  } else if (spec.needsMic && micState === 'ng') {
    verdict = 'ng';
    verdictWhy = 'マイクを使えません。ブラウザの許可設定を確認してください。';
  } else if (role === 'teacher' && !canBroadcastAudio) {
    verdict = 'ng';
    verdictWhy = 'このブラウザでは、授業に使用する音声形式を生成できません。';
  } else if (spec.needsMic && micState !== 'ok') {
    verdict = 'warn';
    verdictWhy = '下の「マイクを確認する」を押してください。';
  } else if (requiredSpeedChecks.some((check) => check.state === 'pending')) {
    verdict = 'warn';
    verdictWhy = '回線速度を測定しています。';
  } else if (requiredSpeedChecks.some((check) => check.measurement.status === 'error')) {
    verdict = 'warn';
    verdictWhy = '回線速度を測定できませんでした。「もう一度測る」を押してください。';
  } else if (requiredSpeedChecks.some((check) => check.state === 'ng')) {
    verdict = 'ng';
    verdictWhy = 'この測定では、授業に必要な回線速度の目安を下回りました。';
  } else if (requiredSpeedChecks.some((check) => check.state === 'warn')) {
    verdict = 'warn';
    verdictWhy = '回線速度が必要な目安に近いため、実際の授業でも確認してください。';
  } else if (spec.needsPlayback && toneState !== 'ok') {
    verdict = 'warn';
    verdictWhy = '下の「テスト音を鳴らす」で、実際に聞こえるか確かめてください。';
  } else {
    verdict = 'ok';
    verdictWhy = '';
  }

  return (
    <div className="check-page">
      {from && (
        <div className="check-back">
          <button className="btn" onClick={() => navigate(from)}>
            ← 元の画面に戻る
          </button>
        </div>
      )}
      <h1>端末チェック</h1>
      <p className="muted">
        確認したい端末で、この画面を開いてください。ログインは必要ありません。
        どの画面からでも <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>C</kbd> で開けます。
      </p>

      <div className="check-roles">
        <span className="check-roles-label">この端末の役割</span>
        <div className="check-roles-row">
          {(Object.keys(ROLES) as Role[]).map((r) => (
            <button
              key={r}
              className={r === role ? 'btn tool tool-active' : 'btn tool'}
              onClick={() => setRole(r)}
            >
              {ROLES[r].label}
              <span className="check-role-hint">{ROLES[r].hint}</span>
            </button>
          ))}
        </div>
      </div>

      <div className={'check-verdict check-' + verdict}>
        <strong>
          {verdict === 'ok'
            ? `この測定では「${spec.label}」として使用できる目安です`
            : verdict === 'ng'
              ? `「${spec.label}」に必要な条件を満たしていません`
              : '確認が必要です'}
        </strong>
        <span>
          {verdictWhy}
          {verdict === 'ng' && playbackUnsupported && netOk
            ? ' 対応形式を再生できる別の端末で確認してください。'
            : ''}
          {verdict === 'ok' ? '端末1台について、測定時点の必要条件を満たしています。' : ''}
        </span>
      </div>

      <section>
        <h2>1. 通信</h2>
        <ul className="check-list">
          <Row state={health} label="サーバに繋がる" />
          <Row
            state={polling}
            label="授業の通信が通る（ポーリング方式）"
            detail={polling === 'ng' ? '×の場合は授業に接続できません' : undefined}
          />
          <Row
            state={websocket}
            label="WebSocketが通る"
            detail={wsDetail || (websocket === 'ok' ? 'WebSocket方式で接続できます' : undefined)}
          />
        </ul>
        {websocket === 'warn' && polling === 'ok' && (
          <p className="check-note">
            WebSocketは通りませんでしたが、ポーリング方式で授業は成立します。
            学校のフィルタリングによるものと思われます。
          </p>
        )}
        <h3>回線速度</h3>
        <ul className="check-list">
          <Row
            state={
              downloadSpeed.status === 'pending'
                ? 'pending'
                : downloadSpeed.status === 'done'
                  ? 'ok'
                  : 'ng'
            }
            label="端末への受信速度"
            detail={
              downloadSpeed.status === 'done' && downloadSpeed.kbps !== null
                ? formatSpeed(downloadSpeed.kbps)
                : downloadSpeed.status === 'error'
                  ? downloadSpeed.error
                  : '測定しています'
            }
          />
          {role === 'teacher' && (
            <Row
              state={
                uploadSpeed.status === 'pending'
                  ? 'pending'
                  : uploadSpeed.status === 'done'
                    ? 'ok'
                    : 'ng'
              }
              label="先生端末からの送信速度"
              detail={
                uploadSpeed.status === 'done' && uploadSpeed.kbps !== null
                  ? formatSpeed(uploadSpeed.kbps)
                  : uploadSpeed.status === 'error'
                    ? uploadSpeed.error
                    : '測定しています'
              }
            />
          )}
        </ul>
        <div className="check-actions">
          <button
            className="btn"
            onClick={() => {
              void measureDownloadSpeed();
              if (role === 'teacher') void measureUploadSpeed();
            }}
            disabled={
              downloadSpeed.status === 'pending' ||
              (role === 'teacher' && uploadSpeed.status === 'pending')
            }
          >
            もう一度測る
          </button>
        </div>
        <h3>この回線で使用できる機能</h3>
        <ul className="check-list">
          <Row
            state={speedState(downloadSpeed, BASIC_DOWNLOAD_KBPS)}
            label="スライド・ボタン・コメント"
            detail={speedDetail(downloadSpeed, BASIC_DOWNLOAD_KBPS)}
          />
          {spec.needsPlayback && (
            <Row
              state={speedState(downloadSpeed, AUDIO_DOWNLOAD_KBPS)}
              label="音声・スライド・書き込み"
              detail={speedDetail(downloadSpeed, AUDIO_DOWNLOAD_KBPS)}
            />
          )}
          {spec.watchesVideo && (
            <Row
              state={speedState(downloadSpeed, VIDEO_DOWNLOAD_KBPS)}
              label="先生のカメラ映像"
              detail={speedDetail(downloadSpeed, VIDEO_DOWNLOAD_KBPS)}
            />
          )}
          {role === 'teacher' && (
            <>
              <Row
                state={speedState(uploadSpeed, AUDIO_UPLOAD_KBPS)}
                label="音声の配信"
                detail={speedDetail(uploadSpeed, AUDIO_UPLOAD_KBPS)}
              />
              <Row
                state={speedState(uploadSpeed, VIDEO_UPLOAD_KBPS)}
                label="カメラ映像の配信"
                detail={speedDetail(uploadSpeed, VIDEO_UPLOAD_KBPS)}
              />
            </>
          )}
        </ul>
        <p className="check-note">
          1回の測定で、受信に約128KB
          {role === 'teacher' ? '、送信に約128KB' : ''}を使用します。
          結果は測定時点の目安です。授業中の回線の混雑によって変わることがあります。
        </p>
        {role === 'student-room' && (
          <p className="check-note">
            この結果は生徒端末1台の判定です。学校全体の回線は、教室数と生徒端末数を含めて確認してください。
          </p>
        )}
        {role === 'student-remote' && websocket !== 'ok' && (
          <p className="check-note">
            WebSocketを使用できない場合は通信方式の上乗せが増えます。
            速度制限中の回線では、実際の授業でも音声を確認してください。
          </p>
        )}
      </section>

      <section>
        <h2>2. 音声の再生</h2>
        {!spec.needsPlayback ? (
          <p className="check-note">
            「{spec.label}」では音声を再生しません
            {role === 'student-room' && '（音は教室のスピーカーから出ます）'}
            {role === 'teacher' && '（先生は自分の声を聞き返しません）'}。
            この項目は合否に影響しません。
          </p>
        ) : null}
        <ul className="check-list">
          <Row
            state={spec.needsPlayback ? (hasMse ? 'ok' : 'ng') : hasMse ? 'ok' : 'skip'}
            label="ライブ音声の仕組みに対応している"
            detail={!hasMse && spec.needsPlayback ? 'これが × だと音を出せません' : undefined}
          />
          {audioSupport.map((f) => (
            <Row
              key={f.mime}
              // 片方だけでも再生できれば、授業中はその形式へ自動的に振り分けられる
              state={
                !spec.needsPlayback ? 'skip' : f.ok ? 'ok' : !hasMse || !canPlayLikely ? 'ng' : 'warn'
              }
              label={f.label}
              detail={f.mime}
            />
          ))}
        </ul>
        {spec.needsPlayback && !audioSupport[0].ok && audioSupport[1].ok && (
          <p className="check-note">
            Opusは再生できませんが、この端末には自動的にAAC音声が送られるため問題ありません。
          </p>
        )}
      </section>

      {spec.needsPlayback && (
        <section>
          <h2>3. スピーカーから音が出るか</h2>
          <p className="muted">
            {role === 'monitor'
              ? '音量はアプリ・OS・モニター本体の3か所にあります。実際に音を確認してください。'
              : 'イヤホンを使う場合は、挿した状態で確認してください。'}
          </p>
          <div className="check-actions">
            <button className="btn primary" onClick={playTone} disabled={tonePlaying}>
              {tonePlaying ? '♪ 鳴らしています…' : '♪ テスト音を鳴らす'}
            </button>
            <button className="btn" onClick={() => setToneState('ok')}>
              聞こえた
            </button>
            <button className="btn" onClick={() => setToneState('ng')}>
              聞こえない
            </button>
          </div>
          {toneHow && <p className="check-note">{toneHow}</p>}
          {toneState === 'ok' && (
            <p className="check-note check-ok-text">音が出ることを確認できました。</p>
          )}
          {toneState === 'ng' && (
            <p className="check-note check-ng-text">
              {role === 'monitor'
                ? '3か所の音量（アプリ・OS・モニター本体）と、モニターの入力切替を確認してください。'
                : '端末の音量と、消音（マナーモード）になっていないかを確認してください。'}
            </p>
          )}
        </section>
      )}

      {spec.watchesVideo && (
        <section>
          <h2>4. 映像の再生（先生の顔・実演）</h2>
          <ul className="check-list">
            {videoSupport.map((f) => (
              <Row key={f.mime} state={f.ok ? 'ok' : 'warn'} label={f.label} detail={f.mime} />
            ))}
          </ul>
          <p className="check-note">映像が再生できなくても、音声とスライドで授業は成立します。</p>
        </section>
      )}

      {spec.needsMic && (
        <section>
          <h2>3. マイクと配信形式</h2>
          <div className="check-actions">
            <button className="btn primary" onClick={checkMic}>
              マイクを確認する
            </button>
          </div>
          <ul className="check-list">
            <Row state={micState} label="マイクを使える" detail={micDetail} />
            <Row
              state={broadcastOpus ? 'ok' : 'warn'}
              label="Opus音声を配信できる"
              detail={broadcastOpus ?? '非対応の場合はAACで録音・配信します'}
            />
            <Row
              state={broadcastAac ? 'ok' : 'warn'}
              label="AAC音声を配信できる"
              detail={broadcastAac ?? 'AACのみを再生できる端末には配信できません'}
            />
            <Row
              state={broadcastVideo ? 'ok' : 'warn'}
              label="映像の配信形式"
              detail={broadcastVideo ?? 'この端末からは映像を配信できません'}
            />
          </ul>
          <div className="check-actions">
            <button className="btn" onClick={() => void measureRate()} disabled={rateBusy > 0}>
              {rateBusy > 0 ? `測定中… あと${rateBusy}秒` : `通信量を測る（${MEASURE_SEC}秒）`}
            </button>
          </div>
          <p className="check-note">
            <strong>測定中は、授業中と同程度の声量で話し続けてください。</strong>
            無音の時間が長い場合は、実際より小さい値になります。
          </p>
          {rateError && <p className="check-note check-ng-text">{rateError}</p>}
          {rateResult && (
            <ul className="check-list">
              <Row
                state={
                  rateResult.opusKbps === null || rateResult.opusKbps === 0
                    ? 'ng'
                    : rateResult.opusKbps <= THROTTLED_KBPS * 0.6
                      ? 'ok'
                      : 'warn'
                }
                label="Opus（標準・対応端末向け）"
                  detail={
                    rateResult.opusKbps === null
                    ? '測定できませんでした'
                    : `${rateResult.opusKbps} kbps ・ ${LESSON_MIN}分で約${Math.round(
                        (rateResult.opusKbps * LESSON_MIN * 60) / 8 / 1000
                      )}MB（生徒1人あたり） ・ 実際の形式 ${rateResult.opusMime ?? '不明'}`
                }
              />
              {rateResult.aacKbps !== null && (
                <Row
                  state={rateResult.aacKbps === 0 ? 'ng' : 'warn'}
                  label="AAC（Opus非対応端末向け）"
                  detail={`${rateResult.aacKbps} kbps ・ ${LESSON_MIN}分で約${Math.round(
                    (rateResult.aacKbps * LESSON_MIN * 60) / 8 / 1000
                  )}MB ・ 実際の形式 ${rateResult.aacMime ?? '不明'}`}
                />
              )}
              <Row
                state="skip"
                label="マイクの形式"
                detail={`${rateResult.channels === 1 ? 'モノラル' : `${rateResult.channels ?? '不明'}ch`} / ${
                  rateResult.sampleRate ? `${rateResult.sampleRate / 1000}kHz` : '周波数不明'
                }`}
              />
            </ul>
          )}
          {rateResult &&
            (!mimeMatches('opus', rateResult.opusMime) ||
              !mimeMatches('aac', rateResult.aacMime)) && (
              <p className="check-note check-ng-text">
                この端末では、指定した形式と異なる形式で記録されました。上の行の
                「実際の形式」を確認してください。形式名だけでは対応状況を判定できません。
              </p>
            )}
          {(rateResult?.opusKbps === 0 || rateResult?.aacKbps === 0) && (
              <p className="check-note check-ng-text">
                {rateResult.opusKbps === 0 ? 'Opus' : 'AAC'}形式では音声が1バイトも出ていません。
                マイクの周波数が48kHz以外の場合、AAC形式で発生することがあります。
                授業中はその形式を自動停止し、先生画面に受信できない端末の警告を表示します。
            </p>
          )}
          {rateResult?.opusKbps != null &&
            rateResult.opusKbps > 0 &&
            rateResult.opusKbps > THROTTLED_KBPS * 0.6 && (
            <p className="check-note">
              速度制限のかかった回線（{THROTTLED_KBPS}kbps程度）で受ける生徒がいる場合、
              この音声量では、書き込みと通信方式の上乗せに使用できる余裕が少なくなります。
              受講に使用する回線で事前に音声を確認してください。
            </p>
          )}
          {rateResult?.opusKbps != null &&
            rateResult.aacKbps != null &&
            rateResult.opusKbps > 0 &&
            rateResult.aacKbps > rateResult.opusKbps * 1.4 && (
              <p className="check-note">
                この端末では、Opus形式のほうが通信量を
                {Math.round((1 - rateResult.opusKbps / rateResult.aacKbps) * 100)}%
                減らせます。授業中はOpus対応端末にこちらを自動的に送ります。
              </p>
            )}
        </section>
      )}

      <details className="check-ua">
        <summary>この端末の情報</summary>
        <p>{navigator.userAgent}</p>
        <p>
          画面 {window.innerWidth}×{window.innerHeight} / 画面スリープ防止{' '}
          {'wakeLock' in navigator ? '対応' : '非対応'}
        </p>
      </details>

      <audio ref={audioElRef} style={{ display: 'none' }} />
    </div>
  );
}
