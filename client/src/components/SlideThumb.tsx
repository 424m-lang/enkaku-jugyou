import { useEffect, useRef } from 'react';
import type { SlideInfo } from '@shared';
import type { PdfCache } from '../lib/pdf';

/** スライドの小さなプレビュー画像（振り返りポイントの一覧などで使用） */
export default function SlideThumb({
  pdf,
  slide,
  width = 150,
}: {
  pdf: PdfCache | null;
  slide: SlideInfo | null;
  width?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const height = Math.round((width * 9) / 16);

  useEffect(() => {
    let cancelled = false;
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    if (pdf && slide && slide.kind === 'pdf_page' && slide.pdfPageIndex !== null) {
      pdf
        .render(slide.pdfPageIndex)
        .then((bmp) => {
          if (cancelled) return;
          // 枠に収まるよう縦横比を保って中央に描く
          const scale = Math.min(width / bmp.width, height / bmp.height);
          const w = bmp.width * scale;
          const h = bmp.height * scale;
          ctx.drawImage(bmp, (width - w) / 2, (height - h) / 2, w, h);
        })
        .catch(() => {});
    } else if (slide?.kind === 'blank') {
      ctx.fillStyle = '#9ca3af';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('白紙スライド', width / 2, height / 2);
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf, slide?.id, width, height]);

  return <canvas ref={ref} className="slide-thumb" style={{ width, height }} />;
}
