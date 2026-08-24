import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 先生画面の道具を出す小さな窓。
 *
 * モーダルにしていないのは、開いたままスライドを送りたいものがあるため
 * （アンケートの集計やタスクの進み具合は、授業を進めながら見るもの）。
 * 邪魔になったらつまんで動かせる。
 *
 * 中身は閉じている間もDOMに残す。書きかけの設問やタスク名が、
 * 閉じただけで消えてしまうと授業中に作り直す羽目になるため。
 */

type Props = {
  title: string;
  open: boolean;
  onClose: () => void;
  /** 画面の左上からの初期位置。ボタンごとにずらして重ならないようにする */
  defaultPos: { x: number; y: number };
  width?: number;
  children: React.ReactNode;
};

const MARGIN = 8;

export default function FloatingWindow({
  title,
  open,
  onClose,
  defaultPos,
  width = 380,
  children,
}: Props) {
  // 小さな画面では初期位置が外へ出てしまうので、置ける範囲に寄せてから始める
  const [pos, setPos] = useState(() => ({
    x: Math.min(defaultPos.x, Math.max(MARGIN, window.innerWidth - width - MARGIN)),
    y: Math.min(defaultPos.y, Math.max(MARGIN, window.innerHeight - 160)),
  }));
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const clamp = useCallback((x: number, y: number) => {
    const w = boxRef.current?.offsetWidth ?? width;
    const maxX = Math.max(MARGIN, window.innerWidth - w - MARGIN);
    const maxY = Math.max(MARGIN, window.innerHeight - 60);
    return { x: Math.min(maxX, Math.max(MARGIN, x)), y: Math.min(maxY, Math.max(MARGIN, y)) };
  }, [width]);

  // 画面が狭くなったときに、窓が外へ出たままにならないようにする
  useEffect(() => {
    const onResize = () => setPos((p) => clamp(p.x, p.y));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clamp]);

  const onPointerDown = (e: React.PointerEvent) => {
    // 閉じるボタンなど、つまみ以外の操作は奪わない
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* 取れなくてもドラッグ自体は動く */
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setPos(clamp(e.clientX - d.dx, e.clientY - d.dy));
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  return (
    <div
      ref={boxRef}
      className={open ? 'float-window' : 'float-window float-window-closed'}
      style={{ left: pos.x, top: pos.y, width }}
      role="dialog"
      aria-label={title}
      aria-hidden={!open}
    >
      <div
        className="float-window-head"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <strong>{title}</strong>
        <button type="button" className="float-window-close" onClick={onClose} title="閉じる">
          ×
        </button>
      </div>
      <div className="float-window-body">{children}</div>
    </div>
  );
}
