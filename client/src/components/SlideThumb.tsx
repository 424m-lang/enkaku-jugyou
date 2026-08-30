import { useEffect, useRef, useState } from 'react';
import type { SlideInfo } from '@shared';
import type { PdfCache } from '../lib/pdf';

type Props = {
  pdf: PdfCache | null;
  slide: SlideInfo | null;
  /** 通し番号（1始まり）。渡すと右下に小さく表示する */
  slideNo?: number | null;
  onClick?: () => void;
  title?: string;
  /** 画面に近づくまでPDFページを描画しない。ページ数の多い一覧で使用する */
  defer?: boolean;
  selected?: boolean;
};

/**
 * スライドの小さなサムネイル。
 * 復習動画のブロック概要（説明していたスライド）とスライド一覧タブで使う。
 * 書き込みは描かず、PDFのページ画像だけを表示する。
 */
export default function SlideThumb({
  pdf,
  slide,
  slideNo,
  onClick,
  title,
  defer = false,
  selected = false,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLButtonElement | HTMLDivElement>(null);
  const [visible, setVisible] = useState(!defer);

  useEffect(() => {
    if (!defer) {
      setVisible(true);
      return;
    }
    const host = hostRef.current;
    if (!host || visible) return;
    if (!('IntersectionObserver' in window)) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '240px' }
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, [defer, visible]);

  useEffect(() => {
    if (!visible) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let cancelled = false;

    const draw = async () => {
      if (!slide || slide.kind === 'blank' || slide.pdfPageIndex === null || !pdf) {
        // 白紙スライドはそのまま白く塗る
        canvas.width = 320;
        canvas.height = 180;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        return;
      }
      try {
        const bmp = await pdf.render(slide.pdfPageIndex);
        if (cancelled) return;
        canvas.width = 320;
        canvas.height = Math.round((320 * bmp.height) / bmp.width);
        ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      } catch {
        /* 個別ページの失敗は無視 */
      }
    };
    void draw();
    return () => {
      cancelled = true;
    };
  }, [pdf, slide, visible]);

  const content = (
    <>
      {visible ? (
        <canvas ref={canvasRef} className="slide-thumb-canvas" />
      ) : (
        <span className="slide-thumb-placeholder" aria-hidden="true" />
      )}
      {slideNo != null && <span className="slide-thumb-no">{slideNo}</span>}
    </>
  );

  return onClick ? (
    <button
      ref={hostRef as React.Ref<HTMLButtonElement>}
      type="button"
      className={`slide-thumb${selected ? ' slide-thumb-selected' : ''}`}
      onClick={onClick}
      title={title}
      aria-current={selected ? 'page' : undefined}
    >
      {content}
    </button>
  ) : (
    <div
      ref={hostRef as React.Ref<HTMLDivElement>}
      className={`slide-thumb${selected ? ' slide-thumb-selected' : ''}`}
      title={title}
    >
      {content}
    </div>
  );
}
