import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerPayload, SlideInfo, StrokePayload, StrokeTool } from '@shared';
import type { PdfCache } from '../lib/pdf';

export type DrawingTool = StrokeTool | 'pointer' | 'none';

type DrawingProps = {
  tool: DrawingTool;
  color: string;
  lineWidth: number; // スライド幅に対する比（例 0.004）
  onStroke: (s: StrokePayload) => void;
  onProgress: (s: StrokePayload) => void;
  onPointer: (x: number, y: number, visible: boolean) => void;
};

type Props = {
  pdf: PdfCache | null;
  slide: SlideInfo | null;
  strokes: StrokePayload[];
  /** 他クライアントから届く描画途中のストローク */
  progressStrokes?: StrokePayload[];
  /** 先生のポインター位置（生徒側で表示） */
  pointer?: PointerPayload | null;
  /** 指定すると描画入力（先生用）が有効になる */
  drawing?: DrawingProps;
};

const DEFAULT_ASPECT = 16 / 9;
const TEXT_FONT_SIZE = 0.06; // スライド高さに対する比

function drawStroke(
  ctx: CanvasRenderingContext2D,
  s: StrokePayload,
  W: number,
  H: number
): void {
  const pts = s.points;
  const n = Math.floor(pts.length / 2);
  if (n === 0) return;
  const px = (i: number) => pts[i * 2] * W;
  const py = (i: number) => pts[i * 2 + 1] * H;

  ctx.save();
  if (s.tool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = 'rgba(0,0,0,1)';
    ctx.fillStyle = 'rgba(0,0,0,1)';
  } else {
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
  }
  ctx.lineWidth = Math.max(1, s.width * W);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  switch (s.tool) {
    case 'pen':
    case 'eraser': {
      if (n === 1) {
        ctx.beginPath();
        ctx.arc(px(0), py(0), ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(px(0), py(0));
        for (let i = 1; i < n; i++) ctx.lineTo(px(i), py(i));
        ctx.stroke();
      }
      break;
    }
    case 'line': {
      ctx.beginPath();
      ctx.moveTo(px(0), py(0));
      ctx.lineTo(px(n - 1), py(n - 1));
      ctx.stroke();
      break;
    }
    case 'rect': {
      const x0 = px(0), y0 = py(0), x1 = px(n - 1), y1 = py(n - 1);
      ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      break;
    }
    case 'ellipse': {
      const x0 = px(0), y0 = py(0), x1 = px(n - 1), y1 = py(n - 1);
      ctx.beginPath();
      ctx.ellipse(
        (x0 + x1) / 2,
        (y0 + y1) / 2,
        Math.abs(x1 - x0) / 2,
        Math.abs(y1 - y0) / 2,
        0,
        0,
        Math.PI * 2
      );
      ctx.stroke();
      break;
    }
    case 'text': {
      ctx.font = `${(s.fontSize ?? TEXT_FONT_SIZE) * H}px 'Hiragino Kaku Gothic ProN', 'Yu Gothic UI', sans-serif`;
      ctx.textBaseline = 'top';
      ctx.fillText(s.text ?? '', px(0), py(0));
      break;
    }
  }
  ctx.restore();
}

/**
 * スライド1枚の表示（PDFページ or 白紙）＋ 書き込みオーバーレイ ＋ ポインター表示。
 * 白紙スライドも通常のPDFページと同じ仕組みで描画・書き込みできる。
 */
export default function SlideCanvas({ pdf, slide, strokes, progressStrokes, pointer, drawing }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [aspect, setAspect] = useState(DEFAULT_ASPECT);
  const [size, setSize] = useState({ w: 800, h: 450 });
  const bitmapRef = useRef<ImageBitmap | null>(null);

  // ローカル描画中ストローク（refで保持し再レンダリングを避ける）
  const localStrokeRef = useRef<StrokePayload | null>(null);
  const lastProgressSentRef = useRef(0);
  const drawingRef = useRef(drawing);
  drawingRef.current = drawing;

  // ---- コンテナサイズへのフィット ----
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const cw = el.clientWidth;
      const ch = el.clientHeight;
      if (cw <= 0 || ch <= 0) return;
      let w = cw;
      let h = w / aspect;
      if (h > ch) {
        h = ch;
        w = h * aspect;
      }
      setSize({ w: Math.floor(w), h: Math.floor(h) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect]);

  // ---- ベース（PDFページ / 白紙）描画 ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let bmp: ImageBitmap | null = null;
      if (pdf && slide && slide.kind === 'pdf_page' && slide.pdfPageIndex !== null) {
        try {
          bmp = await pdf.render(slide.pdfPageIndex);
        } catch {
          bmp = null;
        }
      }
      if (cancelled) return;
      bitmapRef.current = bmp;
      if (bmp) setAspect(bmp.width / bmp.height);
      drawBase();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf, slide?.id]);

  const drawBase = useCallback(() => {
    const canvas = baseRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size.w, size.h);
    const bmp = bitmapRef.current;
    if (bmp) ctx.drawImage(bmp, 0, 0, size.w, size.h);
  }, [size]);

  useEffect(() => {
    drawBase();
  }, [drawBase]);

  // ---- オーバーレイ（ストローク・ポインター）描画 ----
  const drawOverlay = useCallback(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== size.w * dpr || canvas.height !== size.h * dpr) {
      canvas.width = size.w * dpr;
      canvas.height = size.h * dpr;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);

    for (const s of strokes) drawStroke(ctx, s, size.w, size.h);
    for (const s of progressStrokes ?? []) drawStroke(ctx, s, size.w, size.h);
    if (localStrokeRef.current) drawStroke(ctx, localStrokeRef.current, size.w, size.h);

    if (pointer && pointer.visible) {
      const x = pointer.x * size.w;
      const y = pointer.y * size.h;
      ctx.beginPath();
      ctx.fillStyle = 'rgba(239, 68, 68, 0.25)';
      ctx.arc(x, y, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.fillStyle = '#ef4444';
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [size, strokes, progressStrokes, pointer]);

  useEffect(() => {
    drawOverlay();
  }, [drawOverlay]);

  // ---- 描画入力（先生） ----
  const getPos = (e: React.PointerEvent): { x: number; y: number } => {
    const rect = overlayRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const d = drawingRef.current;
    if (!d || !slide || d.tool === 'none') return;
    e.preventDefault();
    const { x, y } = getPos(e);

    if (d.tool === 'pointer') {
      d.onPointer(x, y, true);
      return;
    }
    if (d.tool === 'text') {
      const text = window.prompt('表示するテキストを入力してください');
      if (text && text.trim()) {
        d.onStroke({
          strokeId: crypto.randomUUID(),
          slideId: slide.id,
          tool: 'text',
          color: d.color,
          width: d.lineWidth,
          points: [x, y],
          text: text.trim(),
          fontSize: TEXT_FONT_SIZE,
        });
      }
      return;
    }

    try {
      overlayRef.current!.setPointerCapture(e.pointerId);
    } catch {
      /* 合成イベント等でキャプチャできない場合は無視 */
    }
    localStrokeRef.current = {
      strokeId: crypto.randomUUID(),
      slideId: slide.id,
      tool: d.tool,
      color: d.color,
      width: d.tool === 'eraser' ? d.lineWidth * 6 : d.lineWidth,
      points: [x, y],
    };
    drawOverlay();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drawingRef.current;
    if (!d || !slide || d.tool === 'none') return;
    const { x, y } = getPos(e);

    if (d.tool === 'pointer') {
      d.onPointer(x, y, true);
      return;
    }
    const cur = localStrokeRef.current;
    if (!cur) return;
    if (cur.tool === 'pen' || cur.tool === 'eraser') {
      const pts = cur.points;
      const lx = pts[pts.length - 2];
      const ly = pts[pts.length - 1];
      if (Math.abs(x - lx) + Math.abs(y - ly) > 0.002) {
        pts.push(x, y);
      }
    } else {
      cur.points = [cur.points[0], cur.points[1], x, y];
    }
    drawOverlay();

    const now = performance.now();
    if (now - lastProgressSentRef.current > 66) {
      lastProgressSentRef.current = now;
      d.onProgress({ ...cur, points: [...cur.points] });
    }
  };

  const finishStroke = () => {
    const d = drawingRef.current;
    const cur = localStrokeRef.current;
    if (d && cur) {
      d.onStroke({ ...cur, points: [...cur.points] });
    }
    localStrokeRef.current = null;
    drawOverlay();
  };

  const onPointerUp = (_e: React.PointerEvent) => {
    const d = drawingRef.current;
    if (d?.tool === 'pointer') return; // ポインターは押している間だけでなく移動中も表示
    if (localStrokeRef.current) finishStroke();
  };

  const onPointerLeave = () => {
    const d = drawingRef.current;
    if (d?.tool === 'pointer') d.onPointer(0, 0, false);
  };

  return (
    <div ref={containerRef} className="slide-container">
      <div className="slide-frame" style={{ width: size.w, height: size.h }}>
        <canvas ref={baseRef} style={{ width: size.w, height: size.h }} />
        <canvas
          ref={overlayRef}
          className="slide-overlay"
          style={{
            width: size.w,
            height: size.h,
            touchAction: 'none',
            cursor:
              drawing && drawing.tool !== 'none'
                ? drawing.tool === 'pointer'
                  ? 'crosshair'
                  : 'cell'
                : 'default',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerLeave}
        />
      </div>
    </div>
  );
}
