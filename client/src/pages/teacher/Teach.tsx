import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type {
  LessonStatus,
  ReactionButtonDef,
  ReactionFeedItem,
  ReflectionPoint,
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
  { key: 'pointer', label: 'ポインター' },
  { key: 'pen', label: 'ペン' },
  { key: 'text', label: 'テキスト' },
  { key: 'eraser', label: '消しゴム' },
];
// 黒 ＋ カラーユニバーサルデザイン（Okabe-Ito）の3色。色覚の違いがあっても見分けやすい
const COLORS: { value: string; label: string }[] = [
  { value: '#111827', label: '黒' },
  { value: '#d55e00', label: '朱色' },
  { value: '#0072b2', label: '青' },
  { value: '#009e73', label: '緑' },
];
const WIDTH_MIN = 0.0015;
const WIDTH_MAX = 0.012;
const WIDTH_DEFAULT = 0.004;

// 「最新のリアクション・コメント」に表示する期間
const RECENT_WINDOW_MS = 5 * 60_000;

type RecentItem = ReactionFeedItem & { expiresAt: number };

export default function Teach() {
  const { id: lessonId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [joinCode, setJoinCode] = useState('');
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [points, setPoints] = useState<ReflectionPoint[]>([]);
  const [participantCount, setParticipantCount] = useState(0);
  const [audioState, setAudioState] = useState<'off' | 'on' | 'error'>('off');
  const [loadError, setLoadError] = useState('');
  const [showQr, setShowQr] = useState(false);

  const [tool, setTool] = useState<DrawingTool>('pointer');
  const [color, setColor] = useState(COLORS[0].value);
  const [lineWidth, setLineWidth] = useState(WIDTH_DEFAULT);

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
    pdf,
  } = useLessonLive(lessonId, {
    setup: (socket) => {
      // 先生画面だけが受け取るイベント
      socket.on('participant_count', (n) => setParticipantCount(n));
      socket.on('reaction_feed', (item) => {
        setRecent((prev) =>
          [{ ...item, expiresAt: Date.now() + RECENT_WINDOW_MS }, ...prev].slice(0, 200)
        );
      });
      // 振り返りポイント（新規作成時とAIまとめ完成時に同じイベントで届く → 上書き）
      socket.on('reflection_point', (p) => {
        setPoints((prev) => [p, ...prev.filter((x) => x.id !== p.id)].sort((a, b) => b.startMs - a.startMs));
      });
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

        // 振り返りポイントと直近リアクションを復元（リロード・再接続対応）
        const [pts, rec] = await Promise.all([
          api<ReflectionPoint[]>(`/api/lessons/${lessonId}/reflection-points`),
          api<{ items: (ReactionFeedItem & { ageMs: number })[] }>(
            `/api/lessons/${lessonId}/recent-reactions`
          ),
        ]);
        if (disposed) return;
        setPoints([...pts].sort((a, b) => b.startMs - a.startMs));
        setRecent(
          rec.items
            .map((i) => ({ ...i, expiresAt: Date.now() + Math.max(0, RECENT_WINDOW_MS - i.ageMs) }))
            .reverse()
        );
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) navigate('/login');
        else setLoadError('授業の読み込みに失敗しました');
      }
    })();
    return () => {
      disposed = true;
    };
  }, [lessonId, navigate, setTitle, setButtons, setStatus]);

  // 5分を過ぎた反応を定期的に取り除く
  useEffect(() => {
    const timer = setInterval(
      () => setRecent((prev) => prev.filter((i) => i.expiresAt > Date.now())),
      10_000
    );
    return () => clearInterval(timer);
  }, []);

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

  const onErase = useCallback(
    (slideId: string, strokeIds: string[]) => {
      const p = { slideId, strokeIds };
      setStrokes((prev) => applyDrawingEvent({ ...prev }, 'clear_slide', p));
      socketRef.current?.emit('clear_slide', p);
    },
    [socketRef, setStrokes]
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

  const reactionMeta = makeReactionMeta(buttons);
  const commentCount = recent.filter((r) => r.kind === 'comment').length;

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
                key={c.value}
                className={`color-swatch ${color === c.value ? 'color-active' : ''}`}
                style={{ background: c.value }}
                onClick={() => setColor(c.value)}
                aria-label={`色 ${c.label}`}
                title={c.label}
              />
            ))}
            <span className="toolbar-sep" />
            <label className="size-slider" title="ペン・テキストのサイズ">
              サイズ
              <input
                type="range"
                min={WIDTH_MIN}
                max={WIDTH_MAX}
                step={0.0005}
                value={lineWidth}
                onChange={(e) => setLineWidth(Number(e.target.value))}
              />
              <span className="size-preview">
                <span
                  style={{
                    width: Math.max(3, lineWidth * 1600),
                    height: Math.max(3, lineWidth * 1600),
                    background: color,
                  }}
                />
              </span>
            </label>
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
            drawing={{ tool, color, lineWidth, onStroke, onProgress, onPointer, onErase }}
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
          <div className="card feed-card">
            <h3>
              最新のリアクション・コメント <span className="muted small">（直近5分）</span>
            </h3>
            <div className="recent-chips">
              {buttons.map((b) => (
                <span key={b.key} className="kind-pill" style={{ background: b.color }}>
                  {b.label} ×{recent.filter((r) => r.kind === b.key).length}
                </span>
              ))}
              <span className="kind-pill" style={{ background: '#6b7280' }}>
                コメント ×{commentCount}
              </span>
            </div>
            <div className="feed-list">
              {recent.length === 0 && <p className="muted">直近5分間の反応はありません</p>}
              {recent.map((f) => (
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

          <div className="card points-card">
            <h3>振り返りポイント</h3>
            <div className="points-list">
              {points.length === 0 && (
                <p className="muted">
                  1分以上とどまったスライドごとに、生徒の反応と説明内容のまとめが自動で追加されます
                </p>
              )}
              {points.map((p) => {
                const idx = sortedSlides.findIndex((sl) => sl.id === p.slideId);
                return (
                  <div key={p.id} className="point-card">
                    <div className="point-head">
                      <strong>{idx >= 0 ? `スライド ${idx + 1}` : 'スライド'}</strong>
                      <span className="muted">
                        {fmtClock(p.startMs)}〜{fmtClock(p.endMs)}
                      </span>
                    </div>
                    {Object.keys(p.kinds).length > 0 && (
                      <div className="clip-kinds">
                        {Object.entries(p.kinds).map(([k, n]) => (
                          <span key={k} className="kind-pill" style={{ background: reactionMeta.color(k) }}>
                            {reactionMeta.label(k)} ×{n}
                          </span>
                        ))}
                      </div>
                    )}
                    <p className={p.status === 'ready' ? 'point-summary' : 'muted'}>
                      {p.status === 'pending'
                        ? 'AIがまとめを生成中...'
                        : p.status === 'failed'
                          ? 'まとめの生成に失敗しました'
                          : p.summary}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
