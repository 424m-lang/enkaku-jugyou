import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

type Props = {
  joinCode: string;
  onClose: () => void;
};

/**
 * 参加用QRコードのモーダル。
 * QRには授業コードを埋め込んだ参加URLが入っており、スキャンすると
 * コード入力済みの参加画面が開く（生徒は名前を入れるだけ）。
 * カメラの無い端末向けに、URLと授業コードの手入力案内も併記する。
 */
export default function JoinQrModal({ joinCode, onClose }: Props) {
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const joinUrl = `${window.location.origin}/join?code=${joinCode}`;

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(joinUrl);
    } catch {
      // http（LAN内アクセス等）ではclipboard APIが使えないため旧方式で代替
      const ta = document.createElement('textarea');
      ta.value = joinUrl;
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
    QRCode.toDataURL(joinUrl, {
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
  }, [joinUrl]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal qr-modal" onClick={(e) => e.stopPropagation()}>
        <h2>授業に参加する</h2>
        <p className="qr-step">① カメラでQRコードを読み取る</p>
        {qrDataUrl ? (
          <img className="qr-image" src={qrDataUrl} alt={`参加用QRコード（${joinUrl}）`} />
        ) : (
          <p className="muted">QRコードを生成中...</p>
        )}
        <p className="qr-step">② カメラが無い場合は、ブラウザでこのURLを開いてコードを入力</p>
        <div className="qr-url-row">
          <p className="qr-url">{window.location.origin}/join</p>
          <button className="btn" onClick={() => void copyUrl()}>
            {copied ? 'コピーしました' : 'URLをコピー'}
          </button>
        </div>
        <div className="join-code qr-code-text">{joinCode}</div>
        <button className="btn primary" onClick={onClose}>
          閉じる
        </button>
      </div>
    </div>
  );
}
