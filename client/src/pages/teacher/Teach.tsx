import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type {
  LessonStatus,
  ReactionButtonDef,
  ReactionCounts,
  ReactionFeedItem,
  ReflectionAlert,
  StrokePayload,
} from '@shared';
import { api, ApiError } from '../../lib/api';
import { startAudioBroadcast } from '../../lib/audio';
import { applyDrawingEvent } from '../../lib/strokes';
import { useLessonLive } from '../../lib/useLessonLive';
import { fmtClock } from '../../lib/format';
import { makeReactionMeta } from '../../lib/reactionMeta';
import SlideCanvas, { type DrawingTool } from '../../components/SlideCanvas';
import JoinQrModal from '../../components/JoinQrModal';

const TOOLS: { key: DrawingTool; label: string }[] = [
  { key: 'none', label: '選択' },
  { key: 'pointer', label: 'ポインター' },
  { key: 'pen', label: 'ペン' },
  { key: 'line', label: '直線' },
  { key: 'rect', label: '四角' },
  { key: 'ellipse', label: '楕円' },
  { key: 'text', label: 'テキスト' },
  { key: 'eraser', label: '消しゴム' },
];
const COLORS = ['#111827', '#dc2626', '#2563eb', '#16a34a', '#f59e0b', '#9333ea'];
const WIDTHS: { label: string; value: number }[] = [
  { label: '細', value: 0.002 },
  { label: '中', value: 0.004 },
  { label: '太', value: 0.008 },
];

export default function Teach() {
  const { id: lessonId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [joinCode, setJoinCode] = useState('');
  const [counts, setCounts] = useState<ReactionCounts>({});
  const [feed, setFeed] = useState<ReactionFeedItem[]>([]);
  const [participantCount, setParticipantCount] = useState(0);
  const [alerts, setAlerts] = useState<ReflectionAlert[]>([]);
  const [audioState, setAudioState] = useState<'off' | 'on' | 'error'>('off');
  const [loadError, setLoadError] = useState('');
  const [showQr, setShowQr] = useState(false);

  const [tool, setTool] = useState<DrawingTool>('none');
  const [color, setColor] = useState(COLORS[1]);
  const [lineWidth, setLineWidth] = useState(WIDTHS[1].value);

  const audioStopRef = useRef<{ stop: () => void } | null>(null);

  const {
    socketRef,
    connected,
    title,
    setTitle,
    status,
    setStatus,
    buttons,
    setButtons,
    setSlides,
    sortedSlides,
    currentSlideId,
    currentSlide,
    setCurrentSlideId,
    strokes,
    setStrokes,
    currentProgress,
    reflectionActive,
    pdf,
  } = useLessonLive(lessonId, {
    onLessonState: (st) => setCounts(st.counts),
    setup: (socket) => {
      // 先生画面だけが受け取るイベント
      socket.on('participant_count', (n) => setParticipantCount(n));
      socket.on('reaction_feed', (item, c) => {
        setFeed((prev) => [item, ...prev].slice(0, 100));
        setCounts({ ...c });
      });
      socket.on('reflection_alert', (alert) => {
        setAlerts((prev) => [...prev.filter((a) => a.alertId !== alert.alertId), alert]);
      });
      socket.on('reflection_suggestion', (alertId, suggestion) => {
        setAlerts((prev) => prev.map((a) => (a.alertId === alertId ? { ...a, suggestion } : a)));
      });
      socket.on('reflection_started', () => setAlerts([]));
    },
  });

  const currentIndex = currentSlide ? sortedSlides.indexOf(currentSlide) : -1;

  // ---- 授業情報のロード（参加コードはlesson_stateに含まれないためRESTで取得） ----
  useEffect(() => {
    if (!lessonId) return;
    let disposed = false;
    (async () => {
      try {
        const detail = await api<{
          title: string;
          joinCode: string;
          status: LessonStatus;
          reactionButtons: ReactionButtonDef[];
        }>(`/api/lessons/${lessonId}`);
        if (disposed) return;
        setTitle(detail.title);
        setJoinCode(detail.joinCode);
        setButtons(detail.reactionButtons);
        setStatus(detail.status);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) navigate('/login');
        else setLoadError('授業の読み込みに失敗しました');
      }
    })();
    return () => {
      disposed = true;
    };
  }, [lessonId, navigate, setTitle, setButtons, setStatus]);

  // 画面を離れるときはマイクを止める
  useEffect(() => {
    return () => {
      audioStopRef.current?.stop();
      audioStopRef.current = null;
    };
  }, []);

  // ---- 操作 ----
  const startAudio = useCallback(async () => {
    if (audioStopRef.current) return;
    try {
      const socket = socketRef.current;
      if (!socket) return;
      audioStopRef.current = await startAudioBroadcast(socket);
      setAudioState('on');
    } catch {
      setAudioState('error');
    }
  }, [socketRef]);

  const startLesson = useCallback(() => {
    socketRef.current?.emit('start_lesson', (res) => {
      if (res.ok) {
        setStatus('live');
        void startAudio();
      } else {
        alert(res.error ?? '開始できませんでした');
      }
    });
  }, [socketRef, setStatus, startAudio]);

  const endLesson = useCallback(() => {
    if (!window.confirm('授業を終了しますか？（録音も停止します）')) return;
    socketRef.current?.emit('end_lesson', (res) => {
      if (res.ok) {
        audioStopRef.current?.stop();
        audioStopRef.current = null;
        setAudioState('off');
        navigate(`/review/${lessonId}`);
      } else {
        alert(res.error ?? '終了できませんでした');
      }
    });
  }, [socketRef, lessonId, navigate]);

  const changeSlideTo = useCallback(
    (slideId: string) => {
      setCurrentSlideId(slideId);
      socketRef.current?.emit('slide_change', { slideId });
    },
    [socketRef, setCurrentSlideId]
  );

  const moveSlide = useCallback(
    (delta: number) => {
      if (currentIndex < 0) return;
      const next = sortedSlides[currentIndex + delta];
      if (next) changeSlideTo(next.id);
    },
    [currentIndex, sortedSlides, changeSlideTo]
  );

  const insertBlank = useCallback(() => {
    if (!currentSlide) return;
    socketRef.current?.emit('insert_blank_slide', currentSlide.position, (res) => {
      if (res.ok && res.slides && res.newSlideId) {
        setSlides(res.slides);
        changeSlideTo(res.newSlideId);
      }
    });
  }, [socketRef, currentSlide, setSlides, changeSlideTo]);

  const onStroke = useCallback(
    (p: StrokePayload) => {
      setStrokes((prev) => applyDrawingEvent({ ...prev }, 'stroke', p));
      socketRef.current?.emit('stroke', p);
    },
    [socketRef, setStrokes]
  );

  const onProgress = useCallback(
    (p: StrokePayload) => {
      socketRef.current?.emit('stroke_progress', p);
    },
    [socketRef]
  );

  const onPointer = useCallback(
    (x: number, y: number, visible: boolean) => {
      if (!currentSlide) return;
      socketRef.current?.emit('pointer', { slideId: currentSlide.id, x, y, visible });
    },
    [socketRef, currentSlide]
  );

  const clearCurrentSlide = useCallback(() => {
    if (!currentSlide) return;
    if (!window.confirm('このスライドの書き込みをすべて消しますか？')) return;
    const p = { slideId: currentSlide.id };
    setStrokes((prev) => applyDrawingEvent({ ...prev }, 'clear_slide', p));
    socketRef.current?.emit('clear_slide', p);
  }, [socketRef, currentSlide, setStrokes]);

  const toggleReflection = useCallback(() => {
    if (reflectionActive) socketRef.current?.emit('reflection_end');
    else socketRef.current?.emit('reflection_start');
  }, [socketRef, reflectionActive]);

  const reactionMeta = makeReactionMeta(buttons);

  if (loadError) {
    return (
      <div className="page-center">
        <p className="error">{loadError}</p>
      </div>
    );
  }

  return (
    <div className="teach">
      <header className="app-header">
        <div className="header-left">
          <h1>{title}</h1>
          <span className={`chip chip-${status}`}>
            {status === 'draft' ? '開始前' : status === 'live' ? '授業中' : '終了'}
          </span>
          {!connected && <span className="chip chip-offline">再接続中...</span>}
        </div>
        <div className="header-right">
          <span className="muted">
            参加コード: <strong className="inline-code">{joinCode}</strong>
          </span>
          <button className="btn" onClick={() => setShowQr(true)} disabled={!joinCode}>
            参加用QR
          </button>
          <span className="muted">生徒 {participantCount}人</span>
          {status === 'live' && (
            <span className={audioState === 'on' ? 'rec-on' : 'rec-off'}>
              {audioState === 'on' ? '● 録音・配信中' : audioState === 'error' ? 'マイクエラー' : '音声停止中'}
            </span>
          )}
          {status === 'draft' && (
            <button className="btn primary" onClick={startLesson}>
              授業を開始
            </button>
          )}
          {status === 'live' && (
            <>
              {audioState !== 'on' && (
                <button className="btn" onClick={() => void startAudio()}>
                  マイクを開始
                </button>
              )}
              <button className={reflectionActive ? 'btn' : 'btn primary'} onClick={toggleReflection}>
                {reflectionActive ? '振り返りタイムを終了' : '振り返りタイムを開始'}
              </button>
              <button className="btn danger" onClick={endLesson}>
                授業を終了
              </button>
            </>
          )}
          {status === 'ended' && (
            <button className="btn" onClick={() => navigate(`/review/${lessonId}`)}>
              振り返りへ
            </button>
          )}
        </div>
      </header>

      {showQr && <JoinQrModal joinCode={joinCode} onClose={() => setShowQr(false)} />}

      {/* 振り返りタイム通知（対応するまで消えない） */}
      {alerts.length > 0 && !reflectionActive && (
        <div className="alert-stack">
          {alerts.map((a) => (
            <div key={a.alertId} className="reflection-banner">
              <div className="reflection-banner-head">
                <strong>
                  振り返りタイムです
                  {a.cluster
                    ? `（${fmtClock(a.cluster.centerMs)}頃に${a.cluster.participantCount}人が反応）`
                    : `（定期のお知らせ）`}
                </strong>
                <button className="btn primary" onClick={toggleReflection}>
                  振り返りタイムを開始
                </button>
              </div>
              {a.cluster && (
                <p className="muted">
                  内訳:{' '}
                  {Object.entries(a.cluster.kinds)
                    .map(([k, n]) => `${reactionMeta.label(k)}×${n}`)
                    .join(' / ')}
                </p>
              )}
              <p className="suggestion">
                {a.suggestion ?? 'AIが振り返りポイントを分析中です...'}
              </p>
            </div>
          ))}
        </div>
      )}
      {reflectionActive && (
        <div className="reflection-active-bar">
          振り返りタイム実施中（生徒の画面にも表示されています）
          <button className="btn" onClick={toggleReflection}>
            終了する
          </button>
        </div>
      )}

      <div className="teach-main">
        <div className="slide-area">
          <div className="toolbar">
            {TOOLS.map((t) => (
              <button
                key={t.key}
                className={`btn tool ${tool === t.key ? 'tool-active' : ''}`}
                onClick={() => setTool(t.key)}
              >
                {t.label}
              </button>
            ))}
            <span className="toolbar-sep" />
            {COLORS.map((c) => (
              <button
                key={c}
                className={`color-swatch ${color === c ? 'color-active' : ''}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
                aria-label={`色 ${c}`}
              />
            ))}
            <span className="toolbar-sep" />
            {WIDTHS.map((w) => (
              <button
                key={w.label}
                className={`btn tool ${lineWidth === w.value ? 'tool-active' : ''}`}
                onClick={() => setLineWidth(w.value)}
              >
                {w.label}
              </button>
            ))}
            <span className="toolbar-sep" />
            <button className="btn tool" onClick={clearCurrentSlide}>
              全消去
            </button>
          </div>

          <SlideCanvas
            pdf={pdf}
            slide={currentSlide}
            strokes={currentSlideId ? (strokes[currentSlideId] ?? []) : []}
            progressStrokes={currentProgress}
            drawing={{ tool, color, lineWidth, onStroke, onProgress, onPointer }}
          />

          <div className="slide-nav">
            <button className="btn" onClick={() => moveSlide(-1)} disabled={currentIndex <= 0}>
              ← 前へ
            </button>
            <span>
              {currentIndex + 1} / {sortedSlides.length}
              {currentSlide?.kind === 'blank' && <span className="chip chip-blank">白紙</span>}
            </span>
            <button
              className="btn"
              onClick={() => moveSlide(1)}
              disabled={currentIndex >= sortedSlides.length - 1}
            >
              次へ →
            </button>
            <button className="btn" onClick={insertBlank} title="このスライドの直後に白紙ページを挿入">
              ＋ 白紙を挿入
            </button>
          </div>
        </div>

        <aside className="sidebar">
          <div className="card counts-card">
            <h3>リアクション集計</h3>
            {buttons.map((b) => (
              <div key={b.key} className="count-row">
                <span className="count-label" style={{ borderColor: b.color, color: b.color }}>
                  {b.label}
                </span>
                <strong>{counts[b.key] ?? 0}</strong>
              </div>
            ))}
          </div>
          <div className="card feed-card">
            <h3>リアクション・コメント</h3>
            <div className="feed-list">
              {feed.length === 0 && <p className="muted">まだ反応はありません</p>}
              {feed.map((f) => (
                <div key={f.id} className={`feed-item ${f.kind === 'comment' ? 'feed-comment' : ''}`}>
                  <span className="feed-time">{fmtClock(f.tMs)}</span>
                  <span className="feed-name">{f.participantName}</span>
                  <span className="feed-body">
                    {f.kind === 'comment' ? f.comment : reactionMeta.label(f.kind)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
