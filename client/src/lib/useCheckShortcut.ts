import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * どの画面からでも端末チェック（/check）と開発用通信記録（/telemetry）を開くショートカット。
 *
 * 現地で「音が出ない」「繋がらない」となったときに、授業を抜けてURLを打ち直させると
 * 手間も間違いも増える。授業画面・教室モニターのどこからでも同じ操作で開けるようにし、
 * 「元の画面に戻る」で戻す。
 *
 * Ctrl+Alt+C = 端末チェック、Ctrl+Alt+T = 匿名通信記録。
 * Ctrl+Shift系は開発者ツールやタブ操作に取られるためAltとの組み合わせにしている。
 */
export function useCheckShortcut(): void {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey || !(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      const target = key === 'c' ? '/check' : key === 't' ? '/telemetry' : null;
      if (!target || location.pathname === target) return;
      e.preventDefault();
      navigate(target, { state: { from: location.pathname + location.search } });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate, location]);
}
