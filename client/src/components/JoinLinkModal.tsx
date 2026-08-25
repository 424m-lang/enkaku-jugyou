import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

type Props = {
  joinCode: string;
  onClose: () => void;
};

/**
 * 生徒に授業へ入ってもらうための案内。
 *
 * QRを主役にしていないのは、学校の生徒用端末にはカメラの無いものがあるため。
 * 「URLを開いてコードを入れる」を最初に置き、QRは読み取れる端末のための近道として
 * 並べて出す。どちらも同じ場所に着く。
 */
export default function JoinLinkModal({ joinCode, onClose }: Props) {
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [copied, setCopied] = useState<'url' | 'direct' | null>(null);
  const baseUrl = `${window.location.origin}/join`;
  const directUrl = `${baseUrl}?code=${joinCode}`;

  async function copy(text: string, which: 'url' | 'direct') {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // http（LAN内アクセス等）ではclipboard APIが使えないため旧方式で代替
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(which);
    setTimeout(() => setCopied(null), 1500);
  }

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(directUrl, {
      width: 420,
      margin: 1,
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
  }, [directUrl]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal join-modal" onClick={(e) => e.stopPropagation()}>
        <h2>授業に参加する</h2>

        <div className="join-main">
          <div className="join-col">
            <span className="monitor-open-label">生徒の端末でこのURLを開く</span>
            <code className="monitor-url">{baseUrl}</code>
            <button className="btn" onClick={() => void copy(baseUrl, 'url')}>
              {copied === 'url' ? 'コピーしました' : 'URLをコピー'}
            </button>
            <span className="monitor-open-label">開いた画面でこのコードを入力</span>
            <div className="join-code qr-code-text">{joinCode}</div>
          </div>

          <div className="join-col">
            <span className="monitor-open-label">カメラのある端末はQRでも入れます</span>
            {qrDataUrl ? (
              <img className="join-qr" src={qrDataUrl} alt={`参加用QRコード（${directUrl}）`} />
            ) : (
              <p className="muted">QRコードを生成中...</p>
            )}
            <button className="btn" onClick={() => void copy(directUrl, 'direct')}>
              {copied === 'direct' ? 'コピーしました' : 'コード入り URL をコピー'}
            </button>
            <p className="muted small">
              このURLで開くと、コードの入力を省いて名前だけで参加できます
            </p>
          </div>
        </div>

        <button className="btn primary" onClick={onClose}>
          閉じる
        </button>
      </div>
    </div>
  );
}
