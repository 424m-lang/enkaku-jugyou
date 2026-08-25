import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type { ScreenLayout } from '@shared';
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
};

const LAYOUTS: ScreenLayout[] = ['slide', 'video', 'slide-only'];

export default function MonitorPanel({
  lessonId,
  socketRef,
  screenCount,
  cameraOn,
  screenLayout,
  videoToStudents,
}: Props) {
  const [screenUrl, setScreenUrl] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [cameras, setCameras] = useState<CameraOption[]>([]);
  const [cameraId, setCameraId] = useState('');
  const [cameraError, setCameraError] = useState('');
  const [stream, setStream] = useState<MediaStream | null>(null);

  const broadcastRef = useRef<CameraBroadcast | null>(null);
  const videoSupported = supportedVideoMime() !== null;

  // ---- モニターを開くURL ----
  useEffect(() => {
    let disposed = false;
    void api<{ screenToken: string }>(`/api/lessons/${lessonId}/screen-token`)
      .then(({ screenToken }) => {
        if (!disposed) setScreenUrl(`${window.location.origin}/screen/${lessonId}?k=${screenToken}`);
      })
      .catch(() => {
        // トークンが取れなくても、先生自身の端末なら拡張ディスプレイで使える
        if (!disposed) setScreenUrl(`${window.location.origin}/screen/${lessonId}`);
      });
    return () => {
      disposed = true;
    };
  }, [lessonId]);

  useEffect(() => {
    if (!screenUrl) return;
    let disposed = false;
    void QRCode.toDataURL(screenUrl, {
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
  }, [screenUrl]);

  const copyUrl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(screenUrl);
    } catch {
      // http（LAN内アクセス等）ではclipboard APIが使えないため旧方式で代替
      const ta = document.createElement('textarea');
      ta.value = screenUrl;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [screenUrl]);

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
        const bc = await startCameraBroadcast(socket, deviceId || undefined);
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
          <code className="monitor-url">{screenUrl || '準備中…'}</code>
          <button className="btn" onClick={() => void copyUrl()} disabled={!screenUrl}>
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
                <button
                  key={l}
                  className={`layout-choice ${screenLayout === l ? 'layout-choice-on' : ''}`}
                  onClick={() => setLayout(l)}
                >
                  <LayoutPreview layout={l} stream={stream} />
                  <span className="layout-choice-label">{SCREEN_LAYOUT_LABELS[l]}</span>
                </button>
              ))}
            </div>
            <p className="muted small">授業中にも切り替えられます。</p>

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
 */
function LayoutPreview({ layout, stream }: { layout: ScreenLayout; stream: MediaStream | null }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);

  const cam = (
    <span className="lp-cam">
      <video ref={ref} muted playsInline autoPlay />
      {!stream && <span className="lp-cam-off">カメラ</span>}
    </span>
  );

  return (
    <span className="lp">
      {layout === 'video' ? (
        <>
          <span className="lp-main lp-main-cam">{cam}</span>
          <span className="lp-sub lp-slide">スライド</span>
        </>
      ) : (
        <>
          <span className="lp-main lp-slide">スライド</span>
          {layout === 'slide' && <span className="lp-sub">{cam}</span>}
        </>
      )}
    </span>
  );
}
