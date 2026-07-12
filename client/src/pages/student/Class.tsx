import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  LessonStatus,
  PointerPayload,
  ReactionButtonDef,
  SlideInfo,
  StrokePayload,
} from '@shared';
import { connectLessonSocket, type AppSocket } from '../../lib/socket';
import { loadLessonPdf, type PdfCache } from '../../lib/pdf';
import { LiveAudioPlayer } from '../../lib/audio';
import { ReactionQueue } from '../../lib/reactionQueue';
import { rebuildStrokes, applyDrawingEvent, type StrokesBySlide } from '../../lib/strokes';
import SlideCanvas from '../../components/SlideCanvas';

export default function Class() {
  const navigate = useNavigate();
  const lessonId = sessionStorage.getItem('lessonId');

  const [title, setTitle] = useState('');
  const [status, setStatus] = useState<LessonStatus>('draft');
  const [buttons, setButtons] = useState<ReactionButtonDef[]>([]);
  const [slides, setSlides] = useState<SlideInfo[]>([]);
  const [currentSlideId, setCurrentSlideId] = useState<string | null>(null);
  const [strokes, setStrokes] = useState<StrokesBySlide>({});
  const [remoteProgress, setRemoteProgress] = useState<Record<string, StrokePayload>>({});
  const [pointer, setPointer] = useState<PointerPayload | null>(null);
  const [reflectionActive, setReflectionActive] = useState(false);
  const [connected, setConnected] = useState(false);
  const [pdf, setPdf] = useState<PdfCache | null>(null);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [comment, setComment] = useState('');
  const [queuedCount, setQueuedCount] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);

  const socketRef = useRef<AppSocket | null>(null);
  const audioElRef = useRef<HTMLAudioElement>(null);
  const playerRef = useRef<LiveAudioPlayer | null>(null);
  const queueRef = useRef<ReactionQueue | null>(null);

  const sortedSlides = useMemo(
    () => [...slides].sort((a, b) => a.position - b.position),
    [slides]
  );
  const currentSlide = sortedSlides.find((s) => s.id === currentSlideId) ?? null;

  useEffect(() => {
    if (!lessonId || !sessionStorage.getItem('participantToken')) {
      navigate('/join');
      return;
    }
    let disposed = false;

    void loadLessonPdf(lessonId).then((cache) => {
      if (!disposed) setPdf(cache);
    });

    const socket = connectLessonSocket(lessonId);
    socketRef.current = socket;
    queueRef.current = new ReactionQueue(lessonId, socket);
    setQueuedCount(queueRef.current.pendingCount);

    if (audioElRef.current) {
      playerRef.current = new LiveAudioPlayer(audioElRef.current);
    }

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', (err) => {
      setConnected(false);
      // トークン失効などで認証できない場合は参加画面へ
      if (String(err.message).includes('認証')) navigate('/join');
    });

    socket.on('lesson_state', (st) => {
      setTitle(st.title);
      setStatus(st.status);
      setButtons(st.reactionButtons);
      setSlides(st.slides);
      setCurrentSlideId(st.currentSlideId ?? st.slides[0]?.id ?? null);
      setStrokes(rebuildStrokes(st.drawingEvents));
      setReflectionActive(st.reflectionActive);
    });
    socket.on('slides_updated', (sl) => setSlides(sl));
    socket.on('slide_change', (p) => {
      setCurrentSlideId(p.slideId);
      setPointer(null);
    });
    socket.on('stroke', (p) => {
      setStrokes((prev) => applyDrawingEvent({ ...prev }, 'stroke', p));
      setRemoteProgress((prev) => {
        const { [p.strokeId]: _, ...rest } = prev;
        return rest;
      });
    });
    socket.on('stroke_progress', (p) =>
      setRemoteProgress((prev) => ({ ...prev, [p.strokeId]: p }))
    );
    socket.on('clear_slide', (p) =>
      setStrokes((prev) => applyDrawingEvent({ ...prev }, 'clear_slide', p))
    );
    socket.on('pointer', (p) => setPointer(p));
    socket.on('audio_init', (chunk) => playerRef.current?.reset(chunk));
    socket.on('audio_chunk', (chunk) => playerRef.current?.push(chunk));
    socket.on('reflection_started', () => setReflectionActive(true));
    socket.on('reflection_ended', () => setReflectionActive(false));
    socket.on('lesson_started', () => setStatus('live'));
    socket.on('lesson_ended', () => setStatus('ended'));

    return () => {
      disposed = true;
      socket.disconnect();
      playerRef.current?.dispose();
    };
  }, [lessonId, navigate]);

  const enableAudio = useCallback(() => {
    playerRef.current?.enable();
    setAudioEnabled(true);
  }, []);

  const sendReaction = useCallback(async (kind: string, text?: string) => {
    const q = queueRef.current;
    if (!q) return;
    const result = await q.send(kind, text);
    setQueuedCount(q.pendingCount);
    setFlash(result === 'sent' ? '送信しました' : 'オフラインのため送信待ちに保存しました');
    setTimeout(() => setFlash(null), 1500);
  }, []);

  const sendComment = useCallback(async () => {
    const text = comment.trim();
    if (!text) return;
    setComment('');
    await sendReaction('comment', text);
  }, [comment, sendReaction]);

  if (!lessonId) return null;

  const currentProgress = Object.values(remoteProgress).filter(
    (p) => p.slideId === currentSlideId
  );

  return (
    <div className="class-page">
      <header className="app-header">
        <div className="header-left">
          <h1>{title || '授業'}</h1>
          {!connected && <span className="chip chip-offline">再接続中...</span>}
          {queuedCount > 0 && <span className="chip chip-queued">送信待ち {queuedCount}件</span>}
        </div>
        <div className="header-right">
          {status === 'live' && !audioEnabled && (
            <button className="btn primary" onClick={enableAudio}>
              🔊 音声を再生
            </button>
          )}
        </div>
      </header>

      {reflectionActive && (
        <div className="reflection-active-bar student">
          先生が振り返りタイムを実施しています
        </div>
      )}

      <div className="class-main">
        {status === 'draft' && (
          <div className="page-center">
            <p>授業の開始を待っています...</p>
          </div>
        )}
        {status === 'ended' && (
          <div className="page-center">
            <p>授業は終了しました。おつかれさまでした。</p>
          </div>
        )}
        {status === 'live' && (
          <SlideCanvas
            pdf={pdf}
            slide={currentSlide}
            strokes={currentSlideId ? (strokes[currentSlideId] ?? []) : []}
            progressStrokes={currentProgress}
            pointer={pointer && pointer.slideId === currentSlideId ? pointer : null}
          />
        )}
      </div>

      <footer className="reaction-bar">
        {flash && <div className="flash">{flash}</div>}
        <div className="reaction-buttons">
          {buttons.map((b) => (
            <button
              key={b.key}
              className="reaction-btn"
              style={{ background: b.color }}
              disabled={status !== 'live'}
              onClick={() => void sendReaction(b.key)}
            >
              {b.label}
            </button>
          ))}
        </div>
        <div className="comment-row">
          <input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void sendComment();
            }}
            placeholder="コメントを送る（例: ○○がわかりません）"
            maxLength={200}
            disabled={status !== 'live'}
          />
          <button
            className="btn primary"
            onClick={() => void sendComment()}
            disabled={status !== 'live' || !comment.trim()}
          >
            送信
          </button>
        </div>
      </footer>

      {/* 音声再生用（非表示） */}
      <audio ref={audioElRef} style={{ display: 'none' }} />
    </div>
  );
}
