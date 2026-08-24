import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

type Props = {
  screenUrl: string;
  onClose: () => void;
};

/**
 * 教室の大画面を開くためのURL・QRのモーダル。
 *
 * 大画面は先生のPCとは別の端末（プロジェクタに繋いだ教室PC）で開く想定なので、
 * その端末にURLを渡す手段が要る。URLにはトークンが入っており、
 * 開いた端末は表示専用として授業に接続する（先生のログインは不要）。
 */
export default function ScreenQrModal({ screenUrl, onClose }: Props) {
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [copied, setCopied] = useState(false);

  async function copyUrl() {
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
  }

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(screenUrl, {
      width: 560,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#1f2937', light: '#ffffff' },
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl('');
      });
    return () => {
      cancelled = true;
    };
  }, [screenUrl]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal qr-modal" onClick={(e) => e.stopPropagation()}>
        <h2>教室の大画面に映す</h2>
        <p className="qr-step">プロジェクタに繋いだ端末で、このURLを開いてください</p>
        {qrDataUrl ? (
          <img className="qr-image" src={qrDataUrl} alt="大画面用QRコード" />
        ) : (
          <p className="muted">QRコードを生成中...</p>
        )}
        <div className="qr-url-row">
          <button className="btn" onClick={() => void copyUrl()}>
            {copied ? 'コピーしました' : 'URLをコピー'}
          </button>
          <button
            className="btn"
            onClick={() => window.open(screenUrl, 'lesson-screen', 'popup=yes,width=1024,height=640')}
          >
            この端末の別ウィンドウで開く
          </button>
        </div>
        <p className="muted small">
          開いた画面で「音を鳴らす」を押すと、教室のスピーカーから先生の声が流れます。
          先生も教室にいる場合は、生の声と重なるので押さないでください。
        </p>
        <button className="btn primary" onClick={onClose}>
          閉じる
        </button>
      </div>
    </div>
  );
}
