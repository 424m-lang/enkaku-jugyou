import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * どの画面からでも端末チェック（/check）を開くショートカット。
 *
 * 現地で「音が出ない」「繋がらない」となったときに、授業を抜けてURLを打ち直させると
 * 手間も間違いも増える。授業画面・教室モニターのどこからでも同じ操作で開けるようにし、
 * 「元の画面に戻る」で戻す。
 *
 * Ctrl+Alt+C にしてあるのは、ブラウザ標準・IME・スクリーンリーダーのどれとも
 * ぶつかりにくいため（Ctrl+Shift+C は開発者ツールに取られている）。
 */
const KEY = 'c';

export function useCheckShortcut(): void {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey || !(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() !== KEY) return;
      if (location.pathname === '/check') return;
      e.preventDefault();
      navigate('/check', { state: { from: location.pathname + location.search } });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate, location]);
}
