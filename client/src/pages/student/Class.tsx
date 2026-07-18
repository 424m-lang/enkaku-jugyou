import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { PointerPayload } from '@shared';
import { LiveAudioPlayer } from '../../lib/audio';
import { ReactionQueue } from '../../lib/reactionQueue';
import { useLessonLive } from '../../lib/useLessonLive';
import SlideCanvas from '../../components/SlideCanvas';

export default function Class() {
  const navigate = useNavigate();
  const lessonId = sessionStorage.getItem('lessonId');
  const hasToken = !!sessionStorage.getItem('participantToken');

  const [pointer, setPointer] = useState<PointerPayload | null>(null);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [comment, setComment] = useState('');
  const [queuedCount, setQueuedCount] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);

  const audioElRef = useRef<HTMLAudioElement>(null);
  const playerRef = useRef<LiveAudioPlayer | null>(null);
  const queueRef = useRef<ReactionQueue | null>(null);
  // コメントの対象スライド（入力を始めた時点のスライド。切替後に送っても正しく紐づく）
  const composeSlideRef = useRef<string | null>(null);
  const lastComposeSentRef = useRef(0);

  useEffect(() => {
    if (!lessonId || !hasToken) navigate('/join');
  }, [lessonId, hasToken, navigate]);

  const {
    socketRef,
    connected,
    title,
    status,
    buttons,
    currentSlideId,
    currentSlide,
    strokes,
    currentProgress,
    pdf,
  } = useLessonLive(lessonId && hasToken ? lessonId : null, {
    setup: (socket) => {
      // 生徒画面だけが受け取るイベント
      queueRef.current = new ReactionQueue(lessonId!, socket);
      setQueuedCount(queueRef.current.pendingCount);
      if (audioElRef.current) {
        playerRef.current = new LiveAudioPlayer(audioElRef.current);
      }
      socket.on('connect_error', (err) => {
        // トークン失効などで認証できない場合は参加画面へ
        if (String(err.message).includes('認証')) navigate('/join');
      });
      socket.on('pointer', (p) => setPointer(p));
      socket.on('slide_change', () => setPointer(null));
      socket.on('audio_init', (chunk) => playerRef.current?.reset(chunk));
      socket.on('audio_chunk', (chunk) => playerRef.current?.push(chunk));
    },
  });

  useEffect(() => {
    return () => playerRef.current?.dispose();
  }, []);

  // 入力欄に文字がある間は「入力中」の合図を定期送信し続ける
  // （手が止まって考えている間もサーバ側の要約待ちが切れないように）
  useEffect(() => {
    if (!comment.trim()) return;
    const timer = setInterval(() => {
      const socket = socketRef.current;
      if (socket && composeSlideRef.current) {
        socket.emit('comment_composing', { slideId: composeSlideRef.current, active: true });
      }
    }, 4000);
    return () => clearInterval(timer);
  }, [comment, socketRef]);

  const enableAudio = useCallback(() => {
    playerRef.current?.enable();
    setAudioEnabled(true);
  }, []);

  const sendReaction = useCallback(
    async (kind: string, text?: string, slideId?: string) => {
      const q = queueRef.current;
      if (!q) return;
      const result = await q.send(kind, text, slideId ?? currentSlideId ?? undefined);
      setQueuedCount(q.pendingCount);
      setFlash(result === 'sent' ? '送信しました' : 'オフラインのため送信待ちに保存しました');
      setTimeout(() => setFlash(null), 1500);
    },
    [currentSlideId]
  );

  // コメント入力中の合図（入力中は数秒おきに送り、送信・クリアで解除）
  const onCommentChange = useCallback(
    (value: string) => {
      setComment(value);
      const socket = socketRef.current;
      if (!socket) return;
      if (value.trim()) {
        if (!composeSlideRef.current) composeSlideRef.current = currentSlideId;
        const now = Date.now();
        if (now - lastComposeSentRef.current > 4000 && composeSlideRef.current) {
          lastComposeSentRef.current = now;
          socket.emit('comment_composing', { slideId: composeSlideRef.current, active: true });
        }
      } else if (composeSlideRef.current) {
        socket.emit('comment_composing', { slideId: composeSlideRef.current, active: false });
        composeSlideRef.current = null;
        lastComposeSentRef.current = 0;
      }
    },
    [socketRef, currentSlideId]
  );

  const sendComment = useCallback(async () => {
    const text = comment.trim();
    if (!text) return;
    const slideId = composeSlideRef.current ?? currentSlideId ?? undefined;
    composeSlideRef.current = null;
    lastComposeSentRef.current = 0;
    setComment('');
    await sendReaction('comment', text, slideId);
  }, [comment, sendReaction, currentSlideId]);

  if (!lessonId) return null;

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
            onChange={(e) => onCommentChange(e.target.value)}
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
