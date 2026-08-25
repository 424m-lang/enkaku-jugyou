import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

type Props = {
  joinCode: string;
};

/**
 * 生徒に授業へ入ってもらうための案内。
 *
 * QRを主役にしていないのは、学校の生徒用端末にはカメラの無いものがあるため。
 * 「URLを開いてコードを入れる」を最初に置き、QRは読み取れる端末のための近道として
 * 並べて出す。どちらも同じ場所に着く。
 *
 * 教室モニター設定・音声字幕設定と同じ小窓に入れてあるので、開いたまま授業を進められる。
 * （遅れて入ってくる生徒のために、コードを出しっぱなしにできる）
 */
export default function JoinLinkPanel({ joinCode }: Props) {
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
    <>
      <div className="classroom-sec classroom-sec-divided">
        <span className="monitor-open-label">生徒の端末でこのURLを開く</span>
        <code className="monitor-url">{baseUrl}</code>
        <div className="classroom-row">
          <button className="btn" onClick={() => void copy(baseUrl, 'url')}>
            {copied === 'url' ? 'コピーしました' : 'URLをコピー'}
          </button>
          <span className="muted small">開いた画面でこのコードを入力</span>
        </div>
        <div className="join-code qr-code-text">{joinCode}</div>
      </div>

      <div className="classroom-sec">
        <span className="monitor-open-label">カメラのある端末はQRでも入れます</span>
        <div className="join-qr-row">
          {qrDataUrl ? (
            <img className="monitor-qr" src={qrDataUrl} alt={`参加用QRコード（${directUrl}）`} />
          ) : (
            <p className="muted small">QRコードを生成中...</p>
          )}
          <div className="join-qr-side">
            <button className="btn" onClick={() => void copy(directUrl, 'direct')}>
              {copied === 'direct' ? 'コピーしました' : 'コード入りURLをコピー'}
            </button>
            <p className="muted small">
              このURLで開くと、コードの入力を省いて名前だけで参加できます
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
