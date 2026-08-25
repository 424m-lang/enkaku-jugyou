import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { LiveMediaPlayer, canPlayMime, getMediaSourceCtor } from '../lib/liveMedia';
import { supportedAudioMime } from '../lib/audio';
import { supportedVideoMime } from '../lib/camera';

/**
 * 端末チェックページ（/check）。ログインも授業コードも要らない。
 *
 * 同じ端末でも用途によって必要な条件が変わる（教室のモニターには音が要るが、
 * 教室で受ける生徒の端末には要らない）ため、まず役割を選んでから判定する。
 *
 * 見ているのは3つ:
 * 1. 通信が通るか（学校のフィルタリングでWebSocketが塞がれていないか）
 * 2. 先生が送る形式をこの端末が再生できるか（SafariはWebMを再生できない）
 * 3. 実際にスピーカーから音が出るか（アプリ・OS・モニター本体の3段の音量）
 */

/** 実測にかける秒数。短すぎると無音とのばらつきを拾う */
const MEASURE_SEC = 10;
/** 目安に使う1コマの長さ（分） */
const LESSON_MIN = 50;
/**
 * ギガの上限を超えたあとの速度制限。ここに収まるかが、細い回線の家庭で
 * 授業が成立するかの分かれ目になる。余裕を見て6割を「○」の線にする
 */
const THROTTLED_KBPS = 128;

type AudioRate = {
  liveMime: string;
  /** 本番で使う形式の実測値 */
  liveKbps: number | null;
  /** 比較用のOpus（本番がOpusならnull） */
  opusKbps: number | null;
  channels: number | null;
  /** マイクのサンプリング周波数。48000以外だとAACが何も吐かないことがある */
  sampleRate: number | null;
};

type State = 'pending' | 'ok' | 'warn' | 'ng' | 'skip';
type Role = 'monitor' | 'student-remote' | 'student-room' | 'teacher';

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
    hint: 'マイクとカメラで配信する',
    needsPlayback: false,
    needsMic: true,
    watchesVideo: false,
  },
};

/** 先生が送ってくる可能性のある形式（audio.ts / camera.ts の候補と対応させること） */
const AUDIO_FORMATS = [
  { mime: 'audio/mp4;codecs=mp4a.40.2', label: 'AAC（先生がChrome・Edge・Safariのとき）' },
  { mime: 'audio/webm;codecs=opus', label: 'Opus（先生がFirefoxのとき）' },
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
  const audioElRef = useRef<HTMLAudioElement>(null);
  const playerRef = useRef<LiveMediaPlayer | null>(null);

  const spec = ROLES[role];
  const hasMse = getMediaSourceCtor() !== null;
  const audioSupport = AUDIO_FORMATS.map((f) => ({ ...f, ok: canPlayMime(f.mime) }));
  const videoSupport = VIDEO_FORMATS.map((f) => ({ ...f, ok: canPlayMime(f.mime) }));
  // 先生の環境はChrome・Edge・Safariが大半なので、AACを再生できるかが実質的な合否
  const canPlayLikely = audioSupport[0].ok;
  // 先生の端末がこの環境で配信に使う形式
  const broadcastAudio = supportedAudioMime();
  const broadcastVideo = supportedVideoMime();
  const broadcastIsOpus = !!broadcastAudio && !broadcastAudio.includes('mp4');

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

    const live = supportedAudioMime();
    const opus = 'audio/webm;codecs=opus';
    const targets: { key: 'live' | 'opus'; mime: string }[] = [];
    if (live) targets.push({ key: 'live', mime: live });
    if (!live?.includes('opus') && typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(opus)) {
      targets.push({ key: 'opus', mime: opus });
    }
    if (targets.length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      setRateError('この端末では録音できません');
      return;
    }

    const bytes: Record<string, number> = {};
    const recs = targets.map(({ key, mime }) => {
      const rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 48_000 });
      bytes[key] = 0;
      rec.ondataavailable = (e) => {
        bytes[key] += e.data.size;
      };
      rec.start(500);
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
      liveMime: live ?? '',
      liveKbps: bytes.live !== undefined ? kbps(bytes.live) : null,
      opusKbps: bytes.opus !== undefined ? kbps(bytes.opus) : null,
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
  let verdict: State;
  let verdictWhy = '';
  if (!netOk) {
    verdict = 'ng';
    verdictWhy = 'サーバに繋がりません。ネットワークかフィルタリングの問題です。';
  } else if (spec.needsPlayback && (!hasMse || !canPlayLikely)) {
    verdict = 'ng';
    verdictWhy = !hasMse
      ? 'このブラウザはライブ音声の再生に対応していません。'
      : '先生が送る音声形式を再生できません。';
  } else if (spec.needsMic && micState === 'ng') {
    verdict = 'ng';
    verdictWhy = 'マイクを使えません。ブラウザの許可設定を確認してください。';
  } else if (spec.needsMic && micState !== 'ok') {
    verdict = 'warn';
    verdictWhy = '下の「マイクを確認する」を押してください。';
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
        確認したい端末で、この画面を開いてください。ログインは要りません。
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
            ? `この端末は「${spec.label}」として使えます`
            : verdict === 'ng'
              ? `この端末は「${spec.label}」には使えません`
              : 'あと少しです'}
        </strong>
        <span>
          {verdictWhy}
          {verdict === 'ng' && spec.needsPlayback && netOk
            ? ' Windows・Chromebook・Android の端末をお使いください。'
            : ''}
          {verdict === 'ok' ? '必要な条件をすべて満たしています。' : ''}
        </span>
      </div>

      <section>
        <h2>1. 通信</h2>
        <ul className="check-list">
          <Row state={health} label="サーバに繋がる" />
          <Row
            state={polling}
            label="授業の通信が通る（ポーリング方式）"
            detail={polling === 'ng' ? 'これが × だと授業できません' : undefined}
          />
          <Row
            state={websocket}
            label="WebSocketが通る"
            detail={wsDetail || (websocket === 'ok' ? '最も快適な方式で繋がります' : undefined)}
          />
        </ul>
        {websocket === 'warn' && polling === 'ok' && (
          <p className="check-note">
            WebSocketは通りませんでしたが、ポーリング方式で授業は成立します。
            学校のフィルタリングによるものと思われます。
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
          {audioSupport.map((f, i) => (
            <Row
              key={f.mime}
              // MSEが無い端末では全て×。ある場合、Opusだけの不足は△（先生がFirefoxのときだけ困る）
              state={
                !spec.needsPlayback ? 'skip' : f.ok ? 'ok' : !hasMse || i === 0 ? 'ng' : 'warn'
              }
              label={f.label}
              detail={f.mime}
            />
          ))}
        </ul>
        {spec.needsPlayback && !audioSupport[1].ok && audioSupport[0].ok && (
          <p className="check-note">
            Opusは再生できませんが、先生の環境がChrome・Edge・Safariなら問題ありません。
            先生がFirefoxを使う場合だけ音が出ません。
          </p>
        )}
      </section>

      {spec.needsPlayback && (
        <section>
          <h2>3. スピーカーから音が出るか</h2>
          <p className="muted">
            {role === 'monitor'
              ? '音量はアプリ・OS・モニター本体の3か所にあります。必ず耳で確認してください。'
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
              state={broadcastAudio ? (broadcastIsOpus ? 'warn' : 'ok') : 'ng'}
              label="音声の配信形式"
              detail={broadcastAudio ?? 'この端末からは配信できません'}
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
            <strong>測定中は、普段の授業と同じ声で話し続けてください。</strong>
            黙っていると実際より小さく出ます。
          </p>
          {rateError && <p className="check-note check-ng-text">{rateError}</p>}
          {rateResult && (
            <ul className="check-list">
              <Row
                state={
                  rateResult.liveKbps === null || rateResult.liveKbps === 0
                    ? 'ng'
                    : rateResult.liveKbps <= THROTTLED_KBPS * 0.6
                      ? 'ok'
                      : 'warn'
                }
                label="実際に出る通信量（本番の形式）"
                detail={
                  rateResult.liveKbps === null
                    ? '測れませんでした'
                    : `${rateResult.liveKbps} kbps ・ ${LESSON_MIN}分で約${Math.round(
                        (rateResult.liveKbps * LESSON_MIN * 60) / 8 / 1000
                      )}MB（生徒1人あたり）`
                }
              />
              {rateResult.opusKbps !== null && (
                <Row
                  state="skip"
                  label="参考: Opus形式なら"
                  detail={`${rateResult.opusKbps} kbps ・ ${LESSON_MIN}分で約${Math.round(
                    (rateResult.opusKbps * LESSON_MIN * 60) / 8 / 1000
                  )}MB`}
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
          {rateResult?.liveKbps === 0 && (
            <p className="check-note check-ng-text">
              この形式では音声が1バイトも出ていません。このまま授業をすると
              <strong>誰にも音が届きません</strong>。
              マイクの周波数が48kHz以外だとAAC形式で起きることがあります
              （配信時は自動でWebM形式に切り替わりますが、その場合Apple系の端末では聞けません）。
              別のマイクを試すか、端末の音声設定を確認してください。
            </p>
          )}
          {rateResult?.liveKbps != null && rateResult.liveKbps > 0 && rateResult.liveKbps > THROTTLED_KBPS * 0.6 && (
            <p className="check-note">
              速度制限のかかった回線（{THROTTLED_KBPS}kbps程度）で受ける生徒がいる場合、
              この値だと苦しくなります。通常の光・モバイル回線であれば問題ありません。
            </p>
          )}
          {rateResult?.opusKbps != null &&
            rateResult.liveKbps != null &&
            rateResult.liveKbps > rateResult.opusKbps * 1.4 && (
              <p className="check-note">
                この端末では、Opus形式のほうが通信量を
                {Math.round((1 - rateResult.opusKbps / rateResult.liveKbps) * 100)}%
                減らせます。回線の細い家庭がいる授業では、受け手に合わせて形式を選び分ける価値があります
                （いまはApple系の端末でも聞けるようAAC形式を優先しています）。
              </p>
            )}
          {broadcastIsOpus && (
            <p className="check-note check-ng-text">
              この端末はOpus形式で配信します。
              受け手がiPad・iPhone・Mac・Apple TV・テレビ内蔵ブラウザだと音が出ません。
              Chrome・Edge で開き直すとAAC形式になり、すべての端末に届きます。
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
