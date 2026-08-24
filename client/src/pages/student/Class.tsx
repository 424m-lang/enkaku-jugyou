import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AudioMode, PointerPayload } from '@shared';
import { LiveAudioPlayer } from '../../lib/audio';
import { LiveVideoPlayer, playableVideoMime } from '../../lib/camera';
import { ReactionQueue } from '../../lib/reactionQueue';
import { useLessonLive } from '../../lib/useLessonLive';
import SlideCanvas from '../../components/SlideCanvas';

export default function Class() {
  const navigate = useNavigate();
  const lessonId = sessionStorage.getItem('lessonId');
  const hasToken = !!sessionStorage.getItem('participantToken');

  const [pointer, setPointer] = useState<PointerPayload | null>(null);
  // 自動再生の制限があるため、一度は本人の操作で再生を始める必要がある
  const [audioEnabled, setAudioEnabled] = useState(false);
  // 先生が決めた、この端末で音を鳴らしてよいか（教室で受ける生徒は 'off'）
  const [audioAllowed, setAudioAllowed] = useState<AudioMode>('on');
  const [videoLive, setVideoLive] = useState(false);
  const [comment, setComment] = useState('');
  const [queuedCount, setQueuedCount] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);

  const audioElRef = useRef<HTMLAudioElement>(null);
  const videoElRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<LiveAudioPlayer | null>(null);
  const videoPlayerRef = useRef<LiveVideoPlayer | null>(null);
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
    avHasAudio,
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
      socket.on('audio_permission', (p) => setAudioAllowed(p.audio));

      // カメラ映像は、先生が「遠隔の生徒にも送る」を選んだときだけ届く
      const videoMime = playableVideoMime();
      if (videoElRef.current && videoMime) {
        videoPlayerRef.current = new LiveVideoPlayer(videoElRef.current, videoMime);
      }
      socket.on('av_init', (chunk) => {
        videoPlayerRef.current?.reset(chunk);
        setVideoLive(true);
      });
      socket.on('av_chunk', (chunk) => videoPlayerRef.current?.push(chunk));
      socket.on('av_state', (p) => {
        if (!p.cameraOn || !p.videoToStudents) setVideoLive(false);
      });
    },
  });

  useEffect(() => {
    return () => {
      playerRef.current?.dispose();
      videoPlayerRef.current?.dispose();
    };
  }, []);

  // 音声の出し分け。映像が届いているときは映像側の音を鳴らし、音声のみの
  // ストリームはミュートする（同じ声が二重に鳴らないように）。
  // 受信は両方続けるので、切り替えで音が途切れることはない。
  // 映像に音声が入っていない配信のときは、音声のみのストリームを鳴らし続ける
  useEffect(() => {
    const allowed = audioAllowed === 'on' && audioEnabled;
    const useAvAudio = videoLive && avHasAudio;
    if (audioElRef.current) audioElRef.current.muted = !allowed || useAvAudio;
    if (videoElRef.current) videoElRef.current.muted = !allowed || !useAvAudio;
  }, [audioAllowed, audioEnabled, videoLive, avHasAudio]);

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
    videoPlayerRef.current?.enable();
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
          {status === 'live' && audioAllowed === 'off' && (
            <span className="chip chip-muted" title="先生の設定です">
              🔇 音声は教室のスピーカーから
            </span>
          )}
          {status === 'live' && audioAllowed === 'on' && !audioEnabled && (
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
        {/* 先生のカメラ映像（実演を見せている間だけ届く）。要素は残したまま隠す */}
        <div className={videoLive && status === 'live' ? 'class-video' : 'screen-hidden'}>
          <video ref={videoElRef} className="class-video-el" playsInline autoPlay />
        </div>
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
