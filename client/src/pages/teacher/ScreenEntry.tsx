import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';

/**
 * 教室モニターの短い入口（/m/XXXXXX）。
 *
 * 教室のモニターに繋がっている端末は、テレビ内蔵ブラウザだったり、
 * 教室モニターでは長いURLの入力に適さない場合がある。トークン入りのURLは100文字ほどになるため、
 * 6文字のコードから同じ場所へ着けるようにしてある。
 * ここでは表示用トークンを引いて、本来の /screen へ入れ替えるだけ。
 */
export default function ScreenEntry() {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    void api<{ lessonId: string; screenToken: string }>(
      `/api/screen-entry/${encodeURIComponent(code)}`
    )
      .then(({ lessonId, screenToken }) => {
        if (disposed) return;
        // replace にしておくと、モニター側で「戻る」を押してもこの中継に戻らない
        navigate(`/screen/${lessonId}?k=${screenToken}`, { replace: true });
      })
      .catch((err) => {
        if (!disposed) setError(err instanceof Error ? err.message : '開けませんでした');
      });
    return () => {
      disposed = true;
    };
  }, [code, navigate]);

  return (
    <div className="page-center">
      <div className="card auth-card">
        <h1>教室モニター</h1>
        {error ? (
          <>
            <p className="error">{error}</p>
            <p className="muted small">
              番号の打ち間違いか、授業が終了している可能性があります。
              先生の画面の「教室モニター設定」で番号を確認してください。
            </p>
          </>
        ) : (
          <p className="muted">授業を開いています...</p>
        )}
      </div>
    </div>
  );
}
