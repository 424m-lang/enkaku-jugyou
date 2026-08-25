import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type { PipPos, ScreenLayout, VideoFormat } from '@shared';
import { SCREEN_LAYOUT_LABELS } from '@shared';
import { api } from '../lib/api';
import {
  listCameras,
  startCameraBroadcast,
  supportedVideoMime,
  type CameraBroadcast,
  type CameraOption,
} from '../lib/camera';
import type { AppSocket } from '../lib/socket';

/**
 * 教室モニター（教室の大画面）まわりの設定。
 *
 * - モニターを開くためのURL・QR・この端末の別ウィンドウ
 * - 先生のカメラ映像（顔・手元の実演）と、モニターでの見せ方
 *
 * URL・QR・別ウィンドウを横並びにしてあるのは、この3つが同じ「開き方の選択肢」だから。
 * 教室モニターをQRで読むことは実際には少ないので、QRだけ大きく出すと選び方を誤らせる。
 */

type Props = {
  lessonId: string;
  socketRef: React.MutableRefObject<AppSocket | null>;
  screenCount: number;
  cameraOn: boolean;
  screenLayout: ScreenLayout;
  videoToStudents: boolean;
  /** 小窓の置き場所（0〜1の割合） */
  pipPos: PipPos;
  /** いま流す必要のある映像形式（受け手の顔ぶれからサーバが決める） */
  avFormats: VideoFormat[];
};

const LAYOUTS: ScreenLayout[] = ['slide', 'video', 'slide-only'];

export default function MonitorPanel({
  lessonId,
  socketRef,
  screenCount,
  cameraOn,
  screenLayout,
  videoToStudents,
  pipPos,
  avFormats,
}: Props) {
  // 教室モニターを開くURL。長い方（トークン入り）は別ウィンドウ用、
  // 短い方（/m/コード）は人が打つ用。表示とQRは短い方を使う
  const [screenUrl, setScreenUrl] = useState('');
  const [shortUrl, setShortUrl] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [cameras, setCameras] = useState<CameraOption[]>([]);
  const [cameraId, setCameraId] = useState('');
  const [cameraError, setCameraError] = useState('');
  const [stream, setStream] = useState<MediaStream | null>(null);

  const broadcastRef = useRef<CameraBroadcast | null>(null);
  const videoSupported = supportedVideoMime() !== null;
  // start() のたびに最新の形式を渡せるように、描画とは別に保持する
  const avFormatsRef = useRef(avFormats);
  avFormatsRef.current = avFormats;

  // 受け手の顔ぶれが変わったら、配信中でも流す形式を足し引きする
  // （Apple TVが後から繋がる、といったことが教室では普通に起きる）
  useEffect(() => {
    broadcastRef.current?.setFormats(avFormats);
  }, [avFormats]);

  /**
   * こちらは配信しているのに、サーバは「カメラOFF」だと思っている状態を直す。
   *
   * サーバの再起動（本番ではデプロイのたびに起きる）でセッションの状態は消える。
   * こちらの録画器は動き続けるが、サーバは cameraOn=false なのでチャンクを
   * 捨ててしまい、**誰にも映らないまま先生も気づけない**。しかも
   * 「カメラを映す」を押しても、こちらは配信中のつもりなので何も起きない。
   * 状態がずれていたら、こちらから言い直す
   */
  useEffect(() => {
    const bc = broadcastRef.current;
    if (!bc || cameraOn) return;
    const t = setTimeout(() => {
      if (broadcastRef.current === bc) {
        socketRef.current?.emit('camera_state', { on: true, hasAudio: bc.hasAudio });
      }
    }, 1000); // 開始直後の一瞬のずれで送り直さないよう、少し待ってから
    return () => clearTimeout(t);
  }, [cameraOn, socketRef]);

  // ---- モニターを開くURL ----
  useEffect(() => {
    let disposed = false;
    void api<{ screenToken: string; screenCode?: string }>(
      `/api/lessons/${lessonId}/screen-token`
    )
      .then(({ screenToken, screenCode }) => {
        if (disposed) return;
        setScreenUrl(`${window.location.origin}/screen/${lessonId}?k=${screenToken}`);
        if (screenCode) setShortUrl(`${window.location.origin}/m/${screenCode}`);
      })
      .catch(() => {
        // トークンが取れなくても、先生自身の端末なら拡張ディスプレイで使える
        if (!disposed) setScreenUrl(`${window.location.origin}/screen/${lessonId}`);
      });
    return () => {
      disposed = true;
    };
  }, [lessonId]);

  // 人が打つURLも、QRが指す先も短い方にする（読み取れない端末では手打ちになるため）
  const openUrl = shortUrl || screenUrl;

  useEffect(() => {
    if (!openUrl) return;
    let disposed = false;
    void QRCode.toDataURL(openUrl, {
      width: 400,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#1f2937', light: '#ffffff' },
    })
      .then((url) => {
        if (!disposed) setQrDataUrl(url);
      })
      .catch(() => {
        if (!disposed) setQrDataUrl('');
      });
    return () => {
      disposed = true;
    };
  }, [openUrl]);

  const copyUrl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(openUrl);
    } catch {
      // http（LAN内アクセス等）ではclipboard APIが使えないため旧方式で代替
      const ta = document.createElement('textarea');
      ta.value = openUrl;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [openUrl]);

  // self=1 を付けた画面では参加用QRと「音を鳴らす」を出さない。
  // 先生自身の端末で開くもので、生徒に見せるものでも音を出す先でもないため
  const openSelfWindow = useCallback(() => {
    if (!screenUrl) return;
    const url = screenUrl + (screenUrl.includes('?') ? '&' : '?') + 'self=1';
    window.open(url, 'lesson-screen', 'popup=yes,width=1024,height=640');
  }, [screenUrl]);

  // ---- カメラ ----
  // 画面を離れるときは必ずカメラを解放する（ランプが点いたままにならないように）
  useEffect(() => {
    return () => {
      broadcastRef.current?.stop();
      broadcastRef.current = null;
    };
  }, []);

  const refreshCameras = useCallback(() => {
    void listCameras()
      .then(setCameras)
      .catch(() => setCameras([]));
  }, []);

  useEffect(refreshCameras, [refreshCameras]);

  const start = useCallback(
    async (deviceId?: string) => {
      if (broadcastRef.current) return;
      const socket = socketRef.current;
      if (!socket) return;
      setCameraError('');
      try {
        // 先にサーバへ知らせておく（チャンクが届いたときに中継先が決まっている状態にする）
        socket.emit('camera_state', { on: true });
        const bc = await startCameraBroadcast(
          socket,
          deviceId || undefined,
          avFormatsRef.current
        );
        broadcastRef.current = bc;
        // マイクが取れず映像だけになった場合は、受け手が音声のみの配信を鳴らし続ける
        socket.emit('camera_state', { on: true, hasAudio: bc.hasAudio });
        setStream(bc.stream);
        refreshCameras(); // 許可後はカメラ名が取れるようになる
      } catch (err) {
        socket.emit('camera_state', { on: false });
        setCameraError(err instanceof Error ? err.message : 'カメラを開始できませんでした');
      }
    },
    [socketRef, refreshCameras]
  );

  const stop = useCallback(() => {
    broadcastRef.current?.stop();
    broadcastRef.current = null;
    setStream(null);
    socketRef.current?.emit('camera_state', { on: false });
  }, [socketRef]);

  // カメラを切り替えるときは、いったん止めてから選び直した機器で開き直す
  const changeCamera = useCallback(
    async (deviceId: string) => {
      setCameraId(deviceId);
      if (!broadcastRef.current) return;
      stop();
      await start(deviceId);
    },
    [start, stop]
  );

  const setLayout = useCallback(
    (layout: ScreenLayout) => socketRef.current?.emit('set_av_config', { layout }),
    [socketRef]
  );

  const setPipPos = useCallback(
    (p: PipPos) => socketRef.current?.emit('set_av_config', { pipPos: p }),
    [socketRef]
  );

  return (
    <>
      <div className="monitor-status">
        <span className={screenCount > 0 ? 'chip chip-live' : 'chip chip-offline'}>
          {screenCount > 0 ? `接続中 ${screenCount}台` : '未接続'}
        </span>
        <span className="muted small">
          モニター/電子黒板/プロジェクタに繋いだ端末で、このURLを開いてください
        </span>
      </div>

      <div className="monitor-open">
        <div className="monitor-open-col">
          <span className="monitor-open-label">URL</span>
          <code className="monitor-url">{openUrl || '準備中…'}</code>
          <button className="btn" onClick={() => void copyUrl()} disabled={!openUrl}>
            {copied ? 'コピーしました' : 'URLをコピー'}
          </button>
        </div>
        <div className="monitor-open-col">
          <span className="monitor-open-label">QR</span>
          {qrDataUrl ? (
            <img className="monitor-qr" src={qrDataUrl} alt="教室モニター用QRコード" />
          ) : (
            <p className="muted small">準備中…</p>
          )}
        </div>
        <div className="monitor-open-col">
          <span className="monitor-open-label">この端末</span>
          <p className="muted small">先生のPCを直接つないでいる場合</p>
          <button className="btn" onClick={openSelfWindow} disabled={!screenUrl}>
            別ウィンドウで開く
          </button>
        </div>
      </div>

      <div className="classroom-sec">
        <span className="classroom-label">先生のカメラ</span>
        {!videoSupported ? (
          <p className="muted small">この端末（ブラウザ）は映像の配信に対応していません</p>
        ) : (
          <>
            <div className="classroom-row">
              {cameraOn ? (
                <button className="btn danger" onClick={stop}>
                  カメラを止める
                </button>
              ) : (
                <button className="btn primary" onClick={() => void start(cameraId)}>
                  カメラを映す
                </button>
              )}
              {cameras.length > 1 && (
                <select
                  className="classroom-select"
                  value={cameraId}
                  onChange={(e) => void changeCamera(e.target.value)}
                  title="顔を映すカメラと、手元を映すカメラを切り替えます"
                >
                  <option value="">既定のカメラ</option>
                  {cameras.map((c) => (
                    <option key={c.deviceId} value={c.deviceId}>
                      {c.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {cameraError && <p className="error small">{cameraError}</p>}

            <div className="layout-choices">
              {LAYOUTS.map((l) => (
                <LayoutChoice
                  key={l}
                  layout={l}
                  selected={screenLayout === l}
                  stream={stream}
                  pipPos={pipPos}
                  onSelect={() => setLayout(l)}
                  onMovePip={setPipPos}
                />
              ))}
            </div>
            <p className="muted small">
              授業中にも切り替えられます。
              {screenLayout !== 'slide-only' &&
                ' 小さい方は、この見本の中でドラッグして動かせます。'}
            </p>

            <label className="classroom-check">
              <input
                type="checkbox"
                checked={videoToStudents}
                onChange={(e) =>
                  socketRef.current?.emit('set_av_config', { videoToStudents: e.target.checked })
                }
              />
              遠隔の生徒にも映像を送る
            </label>
            {/* 届く相手は「音声・字幕設定」で決まる。ここだけ入れても届かないことがあり、
                原因が分からないまま「映像が来ない」となりやすいので明示する */}
            <p className="muted small">
              「音声・字幕設定」で<strong>遠隔で参加</strong>にしている生徒にだけ届きます。
              教室で受けている（ミュートの）生徒には送りません。
            </p>
          </>
        )}
      </div>
    </>
  );
}

/**
 * 見せ方の見本。いま映っているカメラをそのまま縮小して置く。
 * 「スライド主体」と「映像主体」は言葉だけではどちらがどちらか分かりにくいので、
 * 縮図で示して選ばせる。
 *
 * 選んでいる見本の中では、小窓をつまんで動かせる。教卓・板書・掲示物と重なる場所は
 * 教室ごとに違うので、隅に固定だと現地で直せないため。
 */
function LayoutChoice({
  layout,
  selected,
  stream,
  pipPos,
  onSelect,
  onMovePip,
}: {
  layout: ScreenLayout;
  selected: boolean;
  stream: MediaStream | null;
  pipPos: PipPos;
  onSelect: () => void;
  onMovePip: (p: PipPos) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const lpRef = useRef<HTMLSpanElement>(null);
  const subRef = useRef<HTMLSpanElement>(null);
  // つまんだ位置と、動かしたかどうか（動かしたときは選択のクリックを起こさない）
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const movedRef = useRef(false);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  const draggable = selected && layout !== 'slide-only';

  const onPointerDown = (e: React.PointerEvent) => {
    if (!draggable || !subRef.current) return;
    e.stopPropagation();
    e.preventDefault();
    const box = subRef.current.getBoundingClientRect();
    dragRef.current = { dx: e.clientX - box.left, dy: e.clientY - box.top };
    movedRef.current = false;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* 取れなくてもドラッグ自体は動く */
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || !lpRef.current || !subRef.current) return;
    const lp = lpRef.current.getBoundingClientRect();
    const box = subRef.current.getBoundingClientRect();
    const availX = lp.width - box.width;
    const availY = lp.height - box.height;
    if (availX <= 0 || availY <= 0) return;
    const x = (e.clientX - d.dx - lp.left) / availX;
    const y = (e.clientY - d.dy - lp.top) / availY;
    movedRef.current = true;
    onMovePip({ x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) });
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const cam = (
    <span className="lp-cam">
      <video ref={videoRef} muted playsInline autoPlay />
      {!stream && <span className="lp-cam-off">カメラ</span>}
    </span>
  );

  const subBox = (content: React.ReactNode, extra = '') => (
    <span
      ref={subRef}
      className={`lp-sub ${extra} ${draggable ? 'lp-sub-drag' : ''}`}
      style={{ '--pip-x': pipPos.x, '--pip-y': pipPos.y } as React.CSSProperties}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      title={draggable ? 'ドラッグで位置を変えられます' : undefined}
    >
      {content}
    </span>
  );

  return (
    <button
      className={`layout-choice ${selected ? 'layout-choice-on' : ''}`}
      onClick={() => {
        // ドラッグの終わりをクリックと取り違えない
        if (movedRef.current) {
          movedRef.current = false;
          return;
        }
        onSelect();
      }}
    >
      <span className="lp" ref={lpRef}>
        {layout === 'video' ? (
          <>
            <span className="lp-main lp-main-cam">{cam}</span>
            {subBox('スライド', 'lp-slide')}
          </>
        ) : (
          <>
            <span className="lp-main lp-slide">スライド</span>
            {layout === 'slide' && subBox(cam)}
          </>
        )}
      </span>
      <span className="layout-choice-label">{SCREEN_LAYOUT_LABELS[layout]}</span>
    </button>
  );
}
