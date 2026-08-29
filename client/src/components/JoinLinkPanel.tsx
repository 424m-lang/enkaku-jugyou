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
  const [copied, setCopied] = useState(false);
  // 配るURLには最初から授業コードを入れておく。
  // 生徒にコードを打たせる手順を残すと、聞き間違い・打ち間違いの分だけ入室が遅れる
  const directUrl = `${window.location.origin}/join?code=${joinCode}`;

  async function copy(text: string) {
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
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
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
        <code className="monitor-url">{directUrl}</code>
        <button className="btn" onClick={() => void copy(directUrl)}>
          {copied ? 'コピーしました' : 'URLをコピー'}
        </button>
        <p className="muted small">授業コードは入力済みです。名前は任意です</p>
      </div>

      <div className="classroom-sec">
        <span className="monitor-open-label">カメラのある端末はQRでも入れます</span>
        {qrDataUrl ? (
          <img className="monitor-qr" src={qrDataUrl} alt={`参加用QRコード（${directUrl}）`} />
        ) : (
          <p className="muted small">QRコードを生成中...</p>
        )}
      </div>
    </>
  );
}
