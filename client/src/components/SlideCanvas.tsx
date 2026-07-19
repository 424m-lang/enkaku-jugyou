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
  /** ストローク単位の削除（消しゴムで使用） */
  onErase: (slideId: string, strokeIds: string[]) => void;
  /**
   * 既存ストロークをまとめて置き換える（テキストの内容変更・移動で使用）。
   * 削除＋追加を1つの操作として扱うので、undo/redoで1回に戻せる
   */
  onReplace: (slideId: string, oldStrokeIds: string[], newStroke: StrokePayload) => void;
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
const FONT_FAMILY = "'Hiragino Kaku Gothic ProN', 'Yu Gothic UI', sans-serif";
const TEXT_FONT_SIZE = 0.06; // スライド高さに対する比（既定値）
const LINE_HEIGHT = 1.3;
const FONT_SIZE_PER_WIDTH = 15; // テキストの文字サイズ = 線の太さ × この係数
// ポインターは単色の点のみ（ハローなし）。彩度を抑えたやわらかい赤で目に刺さらないように
const POINTER_COLOR = '#d9534f';
const POINTER_RADIUS = 7;

function textLines(s: StrokePayload): string[] {
  return (s.text ?? '').split('\n');
}

/** テキストストロークのピクセル座標での外接矩形（当たり判定・エディタ配置用） */
function textMetrics(
  ctx: CanvasRenderingContext2D,
  s: StrokePayload,
  W: number,
  H: number
): { x: number; y: number; w: number; h: number; fs: number } {
  const fs = (s.fontSize ?? TEXT_FONT_SIZE) * H;
  ctx.font = `${fs}px ${FONT_FAMILY}`;
  const lines = textLines(s);
  let w = 0;
  for (const ln of lines) w = Math.max(w, ctx.measureText(ln).width);
  return { x: s.points[0] * W, y: s.points[1] * H, w, h: lines.length * fs * LINE_HEIGHT, fs };
}

function distToSegmentSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx;
  const qy = ay + t * dy;
  return (px - qx) ** 2 + (py - qy) ** 2;
}

/** ストローク単位の当たり判定（消しゴム・テキスト選択用。座標はピクセル） */
function hitStroke(
  ctx: CanvasRenderingContext2D,
  s: StrokePayload,
  xPx: number,
  yPx: number,
  W: number,
  H: number
): boolean {
  if (s.tool === 'text') {
    const m = textMetrics(ctx, s, W, H);
    const pad = 4;
    return (
      xPx >= m.x - pad &&
      xPx <= m.x + Math.max(m.w, 12) + pad &&
      yPx >= m.y - pad &&
      yPx <= m.y + m.h + pad
    );
  }
  const pts = s.points;
  const n = Math.floor(pts.length / 2);
  if (n === 0) return false;
  const tol = Math.max((s.width * W) / 2, 5) + 5;
  if (s.tool === 'rect' || s.tool === 'ellipse') {
    // 旧データ用: 外接矩形（許容幅ぶん拡大）に入っていればヒット
    const x0 = Math.min(pts[0], pts[(n - 1) * 2]) * W - tol;
    const x1 = Math.max(pts[0], pts[(n - 1) * 2]) * W + tol;
    const y0 = Math.min(pts[1], pts[(n - 1) * 2 + 1]) * H - tol;
    const y1 = Math.max(pts[1], pts[(n - 1) * 2 + 1]) * H + tol;
    return xPx >= x0 && xPx <= x1 && yPx >= y0 && yPx <= y1;
  }
  if (n === 1) {
    return (xPx - pts[0] * W) ** 2 + (yPx - pts[1] * H) ** 2 <= tol * tol;
  }
  const tol2 = tol * tol;
  for (let i = 0; i < n - 1; i++) {
    const d2 = distToSegmentSq(
      xPx,
      yPx,
      pts[i * 2] * W,
      pts[i * 2 + 1] * H,
      pts[(i + 1) * 2] * W,
      pts[(i + 1) * 2 + 1] * H
    );
    if (d2 <= tol2) return true;
  }
  return false;
}

/** ストローク全体を平行移動したコピーを返す（テキストの移動用） */
function shiftStroke(s: StrokePayload, dx: number, dy: number): StrokePayload {
  const pts = s.points.map((v, i) =>
    i % 2 === 0 ? Math.min(1, Math.max(0, v + dx)) : Math.min(1, Math.max(0, v + dy))
  );
  return { ...s, points: pts };
}

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
    // 旧データ用（現在の消しゴムはストローク自体を削除する方式）
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
      const fs = (s.fontSize ?? TEXT_FONT_SIZE) * H;
      ctx.font = `${fs}px ${FONT_FAMILY}`;
      ctx.textBaseline = 'top';
      // 編集用textarea（line-height: 1.3）と同じ見た目になるよう行内オフセットを加える
      const off = ((LINE_HEIGHT - 1) / 2) * fs;
      const lines = textLines(s);
      lines.forEach((ln, i) => ctx.fillText(ln, px(0), py(0) + off + i * fs * LINE_HEIGHT));
      break;
    }
  }
  ctx.restore();
}

/** テキストのその場編集の状態 */
type TextEditState = {
  strokeId: string; // 編集中プレビュー配信に使うID（既存編集時は元のID）
  slideId: string;
  x: number;
  y: number;
  text: string;
  color: string;
  fontSize: number;
  width: number;
  isNew: boolean;
  originalText: string; // 変更有無の判定用（新規は ''）
};

type TextDrag = {
  stroke: StrokePayload;
  startX: number;
  startY: number;
  dx: number;
  dy: number;
  moved: boolean;
};

/**
 * スライド1枚の表示（PDFページ or 白紙）＋ 書き込みオーバーレイ ＋ ポインターレイヤ。
 * 白紙スライドも通常のPDFページと同じ仕組みで描画・書き込みできる。
 */
export default function SlideCanvas({ pdf, slide, strokes, progressStrokes, pointer, drawing }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const pointerCanvasRef = useRef<HTMLCanvasElement>(null);
  const [aspect, setAspect] = useState(DEFAULT_ASPECT);
  const [size, setSize] = useState({ w: 800, h: 450 });
  const bitmapRef = useRef<ImageBitmap | null>(null);

  // ローカル描画中ストローク（refで保持し再レンダリングを避ける）
  const localStrokeRef = useRef<StrokePayload | null>(null);
  const lastProgressSentRef = useRef(0);
  const drawingRef = useRef(drawing);
  drawingRef.current = drawing;

  // ポインター: 先生自身のローカル位置＋リモート（生徒側）の補間表示
  const localPtrRef = useRef<{ x: number; y: number } | null>(null);
  const remoteTargetRef = useRef<PointerPayload | null>(null);
  const dispPtrRef = useRef<{ x: number; y: number } | null>(null);
  const rafRef = useRef(0);
  const lastPointerSentRef = useRef(0);

  // テキスト編集・移動、消しゴム
  const [textEdit, setTextEdit] = useState<TextEditState | null>(null);
  const textEditRef = useRef(textEdit);
  textEditRef.current = textEdit;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const textDragRef = useRef<TextDrag | null>(null);
  const editProgressSentRef = useRef(false);
  const eraseActiveRef = useRef(false);

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

  // ---- オーバーレイ（ストローク）描画 ----
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

    // 編集中テキスト・移動中テキスト・プレビュー配信中のストロークは
    // 確定版の代わりにその状態を描く（二重表示を避ける）
    const progressIds = new Set((progressStrokes ?? []).map((p) => p.strokeId));
    const editingId = textEdit?.strokeId ?? null;
    const drag = textDragRef.current;
    for (const s of strokes) {
      if (s.strokeId === editingId) continue;
      if (progressIds.has(s.strokeId)) continue;
      if (drag && s.strokeId === drag.stroke.strokeId) continue;
      drawStroke(ctx, s, size.w, size.h);
    }
    for (const s of progressStrokes ?? []) drawStroke(ctx, s, size.w, size.h);
    if (localStrokeRef.current) drawStroke(ctx, localStrokeRef.current, size.w, size.h);
    if (drag && drag.moved) {
      drawStroke(ctx, shiftStroke(drag.stroke, drag.dx, drag.dy), size.w, size.h);
    }
  }, [size, strokes, progressStrokes, textEdit]);

  useEffect(() => {
    drawOverlay();
  }, [drawOverlay]);

  // ---- ポインターレイヤ（単色の点のみ） ----
  const drawPointerLayer = useCallback(() => {
    const canvas = pointerCanvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== size.w * dpr || canvas.height !== size.h * dpr) {
      canvas.width = size.w * dpr;
      canvas.height = size.h * dpr;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    const remote =
      remoteTargetRef.current && remoteTargetRef.current.visible ? dispPtrRef.current : null;
    const p = localPtrRef.current ?? remote;
    if (!p) return;
    ctx.beginPath();
    ctx.fillStyle = POINTER_COLOR;
    ctx.arc(p.x * size.w, p.y * size.h, POINTER_RADIUS, 0, Math.PI * 2);
    ctx.fill();
  }, [size]);

  useEffect(() => {
    drawPointerLayer();
  }, [drawPointerLayer]);

  // リモートポインターは目標位置へ毎フレーム補間して滑らかに動かす
  useEffect(() => {
    remoteTargetRef.current = pointer ?? null;
    if (!pointer || !pointer.visible) {
      dispPtrRef.current = null;
      drawPointerLayer();
      return;
    }
    if (!dispPtrRef.current) dispPtrRef.current = { x: pointer.x, y: pointer.y };
    if (!rafRef.current) {
      const step = () => {
        const t = remoteTargetRef.current;
        const d = dispPtrRef.current;
        if (!t || !t.visible || !d) {
          rafRef.current = 0;
          drawPointerLayer();
          return;
        }
        d.x += (t.x - d.x) * 0.35;
        d.y += (t.y - d.y) * 0.35;
        drawPointerLayer();
        rafRef.current = requestAnimationFrame(step);
      };
      rafRef.current = requestAnimationFrame(step);
    }
  }, [pointer, drawPointerLayer]);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // ポインター以外のツールに切り替えたら自分のポインター表示を消す
  useEffect(() => {
    if (drawing?.tool !== 'pointer' && localPtrRef.current) {
      localPtrRef.current = null;
      drawPointerLayer();
      drawingRef.current?.onPointer(0, 0, false);
    }
  }, [drawing?.tool, drawPointerLayer]);

  // ---- テキスト編集 ----
  const emitTextProgress = useCallback((te: TextEditState, text: string) => {
    const d = drawingRef.current;
    if (!d) return;
    editProgressSentRef.current = true;
    d.onProgress({
      strokeId: te.strokeId,
      slideId: te.slideId,
      tool: 'text',
      color: te.color,
      width: te.width,
      points: [te.x, te.y],
      text,
      fontSize: te.fontSize,
    });
  }, []);

  const commitTextEdit = useCallback(() => {
    const te = textEditRef.current;
    if (!te) return;
    setTextEdit(null);
    const d = drawingRef.current;
    if (!d) return;
    const progressSent = editProgressSentRef.current;
    editProgressSentRef.current = false;

    if (te.text.trim() === '') {
      // 空のまま確定 → 既存テキストなら削除、新規なら生徒側プレビューだけ消す
      if (!te.isNew) d.onErase(te.slideId, [te.strokeId]);
      else if (progressSent) emitTextProgress(te, '');
      return;
    }
    if (!te.isNew && !progressSent && te.text === te.originalText) return; // 変更なし

    const newStroke: StrokePayload = {
      // 削除→追加の到着順が入れ替わっても壊れないよう、確定版は必ず新しいIDにする
      strokeId: te.isNew ? te.strokeId : crypto.randomUUID(),
      slideId: te.slideId,
      tool: 'text',
      color: te.color,
      width: te.width,
      points: [te.x, te.y],
      text: te.text,
      fontSize: te.fontSize,
    };
    if (te.isNew) {
      d.onStroke(newStroke);
    } else {
      d.onReplace(te.slideId, [te.strokeId], newStroke);
    }
  }, [emitTextProgress]);

  // スライドが切り替わったら編集中のテキストを確定する
  useEffect(() => {
    if (textEditRef.current && textEditRef.current.slideId !== slide?.id) commitTextEdit();
  }, [slide?.id, commitTextEdit]);

  // エディタを開いたらフォーカスしてカーソルを末尾へ
  useEffect(() => {
    if (!textEdit) return;
    const ta = textareaRef.current;
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textEdit?.strokeId]);

  // ---- 描画入力（先生） ----
  const getPos = (e: React.PointerEvent): { x: number; y: number } => {
    const rect = overlayRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  };

  const capturePointer = (e: React.PointerEvent) => {
    try {
      overlayRef.current!.setPointerCapture(e.pointerId);
    } catch {
      /* 合成イベント等でキャプチャできない場合は無視 */
    }
  };

  const eraseAt = (x: number, y: number) => {
    const d = drawingRef.current;
    const ctx = overlayRef.current?.getContext('2d');
    if (!d || !slide || !ctx) return;
    const hits = strokes
      .filter((s) => hitStroke(ctx, s, x * size.w, y * size.h, size.w, size.h))
      .map((s) => s.strokeId);
    if (hits.length > 0) d.onErase(slide.id, hits);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const d = drawingRef.current;
    if (!d || !slide || d.tool === 'none') return;
    e.preventDefault();
    const { x, y } = getPos(e);

    if (d.tool === 'pointer') {
      localPtrRef.current = { x, y };
      drawPointerLayer();
      lastPointerSentRef.current = performance.now();
      d.onPointer(x, y, true);
      return;
    }

    if (d.tool === 'text') {
      if (textEditRef.current) {
        // 編集中に枠外をクリック → 確定のみ（誤って新規作成しない）
        commitTextEdit();
        return;
      }
      const ctx = overlayRef.current?.getContext('2d');
      const hit = ctx
        ? [...strokes]
            .reverse()
            .find((s) => s.tool === 'text' && hitStroke(ctx, s, x * size.w, y * size.h, size.w, size.h))
        : undefined;
      if (hit) {
        // 既存テキスト: ドラッグで移動、動かさず離すと編集
        capturePointer(e);
        textDragRef.current = { stroke: hit, startX: x, startY: y, dx: 0, dy: 0, moved: false };
      } else {
        editProgressSentRef.current = false;
        setTextEdit({
          strokeId: crypto.randomUUID(),
          slideId: slide.id,
          x,
          y,
          text: '',
          color: d.color,
          fontSize: Math.min(0.2, Math.max(0.02, d.lineWidth * FONT_SIZE_PER_WIDTH)),
          width: d.lineWidth,
          isNew: true,
          originalText: '',
        });
      }
      return;
    }

    if (d.tool === 'eraser') {
      capturePointer(e);
      eraseActiveRef.current = true;
      eraseAt(x, y);
      return;
    }

    capturePointer(e);
    localStrokeRef.current = {
      strokeId: crypto.randomUUID(),
      slideId: slide.id,
      tool: d.tool,
      color: d.color,
      width: d.lineWidth,
      points: [x, y],
    };
    drawOverlay();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drawingRef.current;
    if (!d || !slide || d.tool === 'none') return;
    const { x, y } = getPos(e);

    if (d.tool === 'pointer') {
      localPtrRef.current = { x, y };
      drawPointerLayer();
      const now = performance.now();
      if (now - lastPointerSentRef.current > 33) {
        lastPointerSentRef.current = now;
        d.onPointer(x, y, true);
      }
      return;
    }

    if (d.tool === 'text') {
      const drag = textDragRef.current;
      if (!drag) return;
      drag.dx = x - drag.startX;
      drag.dy = y - drag.startY;
      if (Math.abs(drag.dx) + Math.abs(drag.dy) > 0.004) drag.moved = true;
      if (drag.moved) {
        drawOverlay();
        const now = performance.now();
        if (now - lastProgressSentRef.current > 66) {
          lastProgressSentRef.current = now;
          d.onProgress(shiftStroke(drag.stroke, drag.dx, drag.dy));
        }
      }
      return;
    }

    if (d.tool === 'eraser') {
      if (eraseActiveRef.current) eraseAt(x, y);
      return;
    }

    const cur = localStrokeRef.current;
    if (!cur) return;
    if (cur.tool === 'pen') {
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

    if (d?.tool === 'text') {
      const drag = textDragRef.current;
      if (!drag || !slide) return;
      textDragRef.current = null;
      if (drag.moved) {
        // 移動を確定: 元を削除して新しいIDで追加（到着順が入れ替わっても安全）
        const moved = { ...shiftStroke(drag.stroke, drag.dx, drag.dy), strokeId: crypto.randomUUID() };
        d.onReplace(drag.stroke.slideId, [drag.stroke.strokeId], moved);
      } else {
        // 動かさずに離した → その場で内容を編集
        editProgressSentRef.current = false;
        setTextEdit({
          strokeId: drag.stroke.strokeId,
          slideId: drag.stroke.slideId,
          x: drag.stroke.points[0],
          y: drag.stroke.points[1],
          text: drag.stroke.text ?? '',
          color: drag.stroke.color,
          fontSize: drag.stroke.fontSize ?? TEXT_FONT_SIZE,
          width: drag.stroke.width,
          isNew: false,
          originalText: drag.stroke.text ?? '',
        });
      }
      drawOverlay();
      return;
    }

    if (d?.tool === 'eraser') {
      eraseActiveRef.current = false;
      return;
    }

    if (localStrokeRef.current) finishStroke();
  };

  const onPointerLeave = () => {
    const d = drawingRef.current;
    if (d?.tool === 'pointer') {
      localPtrRef.current = null;
      drawPointerLayer();
      d.onPointer(0, 0, false);
    }
  };

  const cursorFor = (tool: DrawingTool): string => {
    switch (tool) {
      case 'pointer':
        return 'none'; // 自分のポインターの点がカーソル代わりになる
      case 'text':
        return 'text';
      case 'eraser':
        return 'cell';
      case 'none':
        return 'default';
      default:
        return 'crosshair';
    }
  };

  // テキストエディタの配置・サイズ（canvas描画とWYSIWYGになるよう同じフォントで実測）
  let editorStyle: React.CSSProperties | null = null;
  if (textEdit) {
    const fs = textEdit.fontSize * size.h;
    const lines = textEdit.text.split('\n');
    let wpx = 40;
    const ctx = overlayRef.current?.getContext('2d');
    if (ctx) {
      ctx.font = `${fs}px ${FONT_FAMILY}`;
      for (const ln of lines) wpx = Math.max(wpx, ctx.measureText(ln).width);
    } else {
      wpx = Math.max(40, ...lines.map((l) => l.length * fs));
    }
    const left = textEdit.x * size.w;
    const top = textEdit.y * size.h;
    editorStyle = {
      left,
      top,
      width: Math.min(wpx + fs + 8, Math.max(60, size.w - left)),
      height: lines.length * fs * LINE_HEIGHT + 6,
      fontSize: fs,
      lineHeight: `${LINE_HEIGHT}`,
      fontFamily: FONT_FAMILY,
      color: textEdit.color,
      caretColor: textEdit.color,
    };
  }

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
            cursor: drawing ? cursorFor(drawing.tool) : 'default',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerLeave}
        />
        <canvas
          ref={pointerCanvasRef}
          className="slide-pointer"
          style={{ width: size.w, height: size.h }}
        />
        {textEdit && editorStyle && (
          <textarea
            ref={textareaRef}
            className="text-annotation-editor"
            style={editorStyle}
            value={textEdit.text}
            wrap="off"
            spellCheck={false}
            onChange={(e) => {
              const text = e.target.value;
              setTextEdit((prev) => (prev ? { ...prev, text } : prev));
              const te = textEditRef.current;
              if (te) emitTextProgress({ ...te, text }, text);
            }}
            onBlur={() => commitTextEdit()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                commitTextEdit();
              }
            }}
          />
        )}
      </div>
    </div>
  );
}
