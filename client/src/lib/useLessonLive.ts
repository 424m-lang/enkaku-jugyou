import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  LessonStatus,
  LiveLessonState,
  ReactionButtonDef,
  SlideInfo,
  StrokePayload,
} from '@shared';
import { connectLessonSocket, type AppSocket } from './socket';
import { loadLessonPdf, type PdfCache } from './pdf';
import { rebuildStrokes, applyDrawingEvent, type StrokesBySlide } from './strokes';

type Options = {
  /** lesson_state 受信時の追加処理（集計の反映など） */
  onLessonState?: (st: LiveLessonState) => void;
  /** ページ固有のソケットハンドラ登録（接続確立時に一度だけ呼ばれる） */
  setup?: (socket: AppSocket) => void;
};

/**
 * 授業ルームのライブ状態を扱う共通フック（先生・生徒の両画面で使用）。
 * ソケット接続、スライド・書き込み・進行状況の同期、PDFのプリロードまでを担当し、
 * ページ固有のイベントは options.setup で追加登録する。
 */
export function useLessonLive(lessonId: string | null | undefined, options: Options = {}) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const socketRef = useRef<AppSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState<LessonStatus>('draft');
  const [buttons, setButtons] = useState<ReactionButtonDef[]>([]);
  const [slides, setSlides] = useState<SlideInfo[]>([]);
  const [currentSlideId, setCurrentSlideId] = useState<string | null>(null);
  const [strokes, setStrokes] = useState<StrokesBySlide>({});
  const [remoteProgress, setRemoteProgress] = useState<Record<string, StrokePayload>>({});
  const [reflectionActive, setReflectionActive] = useState(false);
  const [pdf, setPdf] = useState<PdfCache | null>(null);

  useEffect(() => {
    if (!lessonId) return;
    let disposed = false;

    void loadLessonPdf(lessonId).then((cache) => {
      if (!disposed) setPdf(cache);
    });

    const socket = connectLessonSocket(lessonId);
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));

    // 参加・再接続時にサーバから届く状態スナップショット
    socket.on('lesson_state', (st) => {
      setTitle(st.title);
      setStatus(st.status);
      setButtons(st.reactionButtons);
      setSlides(st.slides);
      setCurrentSlideId((cur) => st.currentSlideId ?? cur ?? st.slides[0]?.id ?? null);
      setStrokes(rebuildStrokes(st.drawingEvents));
      setReflectionActive(st.reflectionActive);
      optionsRef.current.onLessonState?.(st);
    });

    socket.on('slides_updated', (sl) => setSlides(sl));
    socket.on('slide_change', (p) => setCurrentSlideId(p.slideId));
    socket.on('stroke', (p) => {
      setStrokes((prev) => applyDrawingEvent({ ...prev }, 'stroke', p));
      // 確定ストロークが届いたら描画途中のプレビューは破棄
      setRemoteProgress((prev) => {
        const { [p.strokeId]: _, ...rest } = prev;
        return rest;
      });
    });
    socket.on('stroke_progress', (p) =>
      setRemoteProgress((prev) => ({ ...prev, [p.strokeId]: p }))
    );
    socket.on('clear_slide', (p) => {
      setStrokes((prev) => applyDrawingEvent({ ...prev }, 'clear_slide', p));
      // 削除されたストロークの描画途中プレビューも破棄（テキスト編集・移動で使用）
      if (p.strokeIds && p.strokeIds.length > 0) {
        setRemoteProgress((prev) => {
          const next = { ...prev };
          for (const id of p.strokeIds!) delete next[id];
          return next;
        });
      }
    });
    socket.on('reflection_started', () => setReflectionActive(true));
    socket.on('reflection_ended', () => setReflectionActive(false));
    socket.on('lesson_started', () => setStatus('live'));
    socket.on('lesson_ended', () => setStatus('ended'));

    optionsRef.current.setup?.(socket);

    return () => {
      disposed = true;
      socket.disconnect();
      socketRef.current = null;
    };
  }, [lessonId]);

  const sortedSlides = useMemo(
    () => [...slides].sort((a, b) => a.position - b.position),
    [slides]
  );
  const currentSlide = sortedSlides.find((s) => s.id === currentSlideId) ?? null;
  const currentProgress = useMemo(
    () => Object.values(remoteProgress).filter((p) => p.slideId === currentSlideId),
    [remoteProgress, currentSlideId]
  );

  return {
    socketRef,
    connected,
    title,
    setTitle,
    status,
    setStatus,
    buttons,
    setButtons,
    slides,
    setSlides,
    sortedSlides,
    currentSlideId,
    setCurrentSlideId,
    currentSlide,
    strokes,
    setStrokes,
    currentProgress,
    reflectionActive,
    pdf,
  };
}
