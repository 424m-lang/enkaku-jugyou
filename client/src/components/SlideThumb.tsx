import { useEffect, useRef } from 'react';
import type { SlideInfo } from '@shared';
import type { PdfCache } from '../lib/pdf';

type Props = {
  pdf: PdfCache | null;
  slide: SlideInfo | null;
  /** 通し番号（1始まり）。渡すと右下に小さく表示する */
  slideNo?: number | null;
  onClick?: () => void;
  title?: string;
};

/**
 * スライドの小さなサムネイル。
 * 復習動画のブロック概要（説明していたスライド）とスライド一覧タブで使う。
 * 書き込みは描かず、PDFのページ画像だけを表示する。
 */
export default function SlideThumb({ pdf, slide, slideNo, onClick, title }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
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
  }, [pdf, slide]);

  const content = (
    <>
      <canvas ref={canvasRef} className="slide-thumb-canvas" />
      {slideNo != null && <span className="slide-thumb-no">{slideNo}</span>}
    </>
  );

  return onClick ? (
    <button type="button" className="slide-thumb" onClick={onClick} title={title}>
      {content}
    </button>
  ) : (
    <div className="slide-thumb" title={title}>
      {content}
    </div>
  );
}
