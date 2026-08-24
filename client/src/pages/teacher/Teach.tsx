import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type {
  CommentInsight,
  LessonStatus,
  ParticipantInfo,
  ReactionButtonDef,
  ReactionFeedItem,
  StrokePayload,
  TaskMode,
  TaskProgressEntry,
} from '@shared';
import { api, ApiError } from '../../lib/api';
import { startAudioBroadcast } from '../../lib/audio';
import { applyDrawingEvent } from '../../lib/strokes';
import { useLessonLive } from '../../lib/useLessonLive';
import { savePdfTexts } from '../../lib/pdf';
import { fmtClock } from '../../lib/format';
import { makeReactionMeta } from '../../lib/reactionMeta';
import SlideCanvas, { type DrawingTool } from '../../components/SlideCanvas';
import JoinQrModal from '../../components/JoinQrModal';
import ClassroomPanel from '../../components/ClassroomPanel';
import TaskPanel from '../../components/TaskPanel';

// 黒 ＋ カラーユニバーサルデザイン（Okabe-Ito）の3色。色覚の違いがあっても見分けやすい
const COLORS: { value: string; label: string }[] = [
  { value: '#111827', label: '黒' },
  { value: '#d55e00', label: '朱色' },
  { value: '#0072b2', label: '青' },
  { value: '#009e73', label: '緑' },
];
// サイズはスライダーの整数目盛り × この単位で扱う（端まで確実に動かせるように）
const WIDTH_UNIT = 0.0005;
const WIDTH_MIN_STEPS = 3; // 0.0015
const WIDTH_MAX_STEPS = 24; // 0.012
const WIDTH_DEFAULT = 8 * WIDTH_UNIT; // 0.004

// ---- 描画のUndo/Redo ----
// ペン・文字の追加/削除/置き換えを1操作として記録し、スライドごとに戻す・やり直せるようにする
type DrawCommand =
  | { type: 'add'; stroke: StrokePayload }
  | { type: 'erase'; slideId: string; strokes: StrokePayload[] }
  | { type: 'replace'; slideId: string; oldStrokes: StrokePayload[]; newStroke: StrokePayload };

function commandSlideId(cmd: DrawCommand): string {
  return cmd.type === 'add' ? cmd.stroke.slideId : cmd.slideId;
}

// 「直近のリアクション」の集計対象期間
const RECENT_WINDOW_MS = 5 * 60_000;

// コメント・振り返りカードの並び順キー（最後に動きがあったカードを上に）
function insightSortKey(p: CommentInsight): number {
  return p.comments[p.comments.length - 1]?.tMs ?? p.windowStartMs;
}

export default function Teach() {
  const { id: lessonId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [joinCode, setJoinCode] = useState('');
  const [reactions, setReactions] = useState<ReactionFeedItem[]>([]);
  const [insights, setInsights] = useState<CommentInsight[]>([]);
  const [taskProgress, setTaskProgress] = useState<TaskProgressEntry[]>([]);
  const [participantCount, setParticipantCount] = useState(0);
  const [participants, setParticipants] = useState<ParticipantInfo[]>([]);
  const [screenCount, setScreenCount] = useState(0);
  const [audioState, setAudioState] = useState<'off' | 'on' | 'error'>('off');
  const [loadError, setLoadError] = useState('');
  const [showQr, setShowQr] = useState(false);

  const [tool, setTool] = useState<DrawingTool>('pointer');
  const [color, setColor] = useState(COLORS[0].value);
  const [lineWidth, setLineWidth] = useState(WIDTH_DEFAULT);

  // スライドごとのundo/redo履歴（表示中のスライドの操作だけを戻す・やり直す）
  const [undoStacks, setUndoStacks] = useState<Record<string, DrawCommand[]>>({});
  const [redoStacks, setRedoStacks] = useState<Record<string, DrawCommand[]>>({});

  const audioStopRef = useRef<{ stop: () => void } | null>(null);
  // 「直近のリアクション」の判定に使う授業タイムライン時計（サーバ時刻基準）
  const lessonClockRef = useRef<{ startedAtEpochMs: number | null; offsetMs: number }>({
    startedAtEpochMs: null,
    offsetMs: 0,
  });
  // 5分窓の集計を時間経過でも更新するための定期タイマー
  const [nowTick, setNowTick] = useState(() => Date.now());

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
    audioDefault,
    cameraOn,
    screenLayout,
    videoToStudents,
    tasks,
    taskMode,
    tasksActive,
  } = useLessonLive(lessonId, {
    onLessonState: (st) => {
      lessonClockRef.current = {
        startedAtEpochMs: st.startedAtEpochMs,
        offsetMs: st.serverNowEpochMs - Date.now(),
      };
    },
    setup: (socket) => {
      // 先生画面だけが受け取るイベント
      socket.on('participant_count', (n) => setParticipantCount(n));
      socket.on('participants', (list) => setParticipants(list));
      socket.on('screen_count', (n) => setScreenCount(n));
      socket.on('reaction_feed', (item) => {
        // 同じ反応が重複して届いても二重表示しない（再接続時の取りこぼし補完に備える）
        setReactions((prev) =>
          prev.some((r) => r.id === item.id) ? prev : [item, ...prev]
        );
      });
      // コメント・振り返り（コメント到着時とAI分析完成時に同じidで届く → 上書き）
      socket.on('comment_insight', (p) => {
        setInsights((prev) =>
          [p, ...prev.filter((x) => x.id !== p.id)].sort(
            (a, b) => insightSortKey(b) - insightSortKey(a)
          )
        );
      });
      // 既存カードへ統合されて不要になったカードを取り除く
      socket.on('comment_insight_removed', (id) => {
        setInsights((prev) => prev.filter((x) => x.id !== id));
      });
      // タスクの進捗（接続直後に全件、以後は動いた生徒の分だけ届く）
      socket.on('task_progress_all', (list) => setTaskProgress(list));
      socket.on('task_progress', (entry) => {
        setTaskProgress((prev) => {
          const i = prev.findIndex((p) => p.participantId === entry.participantId);
          if (i < 0) return [...prev, entry];
          const next = [...prev];
          next[i] = entry;
          return next;
        });
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

        // コメント・振り返りとリアクションを復元（リロード・再接続対応）
        const [ins, rec] = await Promise.all([
          api<CommentInsight[]>(`/api/lessons/${lessonId}/comment-insights`),
          api<{ items: ReactionFeedItem[] }>(`/api/lessons/${lessonId}/reactions`),
        ]);
        if (disposed) return;
        setInsights([...ins].sort((a, b) => insightSortKey(b) - insightSortKey(a)));
        setReactions([...rec.items].reverse()); // 新しい順に保持
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) navigate('/login');
        else setLoadError('授業の読み込みに失敗しました');
      }
    })();
    return () => {
      disposed = true;
    };
  }, [lessonId, navigate, setTitle, setButtons, setStatus]);

  // スライドの本文をサーバへ渡しておく。授業中の文字起こしに用語のヒントとして使われ、
  // 専門用語の認識が崩れにくくなる（授業後の復習動画のブロック分けにも使う）
  useEffect(() => {
    if (!lessonId || !pdf) return;
    void savePdfTexts(lessonId, pdf).catch(() => {
      /* テキストを持たないPDFもあるので失敗は無視 */
    });
  }, [lessonId, pdf]);

  // 画面を離れるときはマイクを止める
  useEffect(() => {
    return () => {
      audioStopRef.current?.stop();
      audioStopRef.current = null;
    };
  }, []);

  // 「直近のリアクション」: 授業中は30秒ごとに再集計して窓から外れた反応を落とす
  useEffect(() => {
    if (status !== 'live') return;
    const timer = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [status]);

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

  // ---- 描画の反映（undo/redo履歴には積まない下位関数） ----
  const addLocal = useCallback(
    (p: StrokePayload) => {
      setStrokes((prev) => applyDrawingEvent({ ...prev }, 'stroke', p));
      socketRef.current?.emit('stroke', p);
    },
    [socketRef, setStrokes]
  );

  const eraseLocal = useCallback(
    (slideId: string, strokeIds: string[]) => {
      const p = { slideId, strokeIds };
      setStrokes((prev) => applyDrawingEvent({ ...prev }, 'clear_slide', p));
      socketRef.current?.emit('clear_slide', p);
    },
    [socketRef, setStrokes]
  );

  // 新しい操作を履歴に積む。分岐した時点でredo履歴は無効になる
  const pushUndo = useCallback((cmd: DrawCommand) => {
    const sid = commandSlideId(cmd);
    setUndoStacks((prev) => ({ ...prev, [sid]: [...(prev[sid] ?? []), cmd] }));
    setRedoStacks((prev) => (prev[sid]?.length ? { ...prev, [sid]: [] } : prev));
  }, []);

  const onStroke = useCallback(
    (p: StrokePayload) => {
      addLocal(p);
      pushUndo({ type: 'add', stroke: p });
    },
    [addLocal, pushUndo]
  );

  const onProgress = useCallback(
    (p: StrokePayload) => {
      socketRef.current?.emit('stroke_progress', p);
    },
    [socketRef]
  );

  const onErase = useCallback(
    (slideId: string, strokeIds: string[]) => {
      const removed = (strokes[slideId] ?? []).filter((s) => strokeIds.includes(s.strokeId));
      eraseLocal(slideId, strokeIds);
      if (removed.length > 0) pushUndo({ type: 'erase', slideId, strokes: removed });
    },
    [strokes, eraseLocal, pushUndo]
  );

  const onReplace = useCallback(
    (slideId: string, oldStrokeIds: string[], newStroke: StrokePayload) => {
      const oldStrokes = (strokes[slideId] ?? []).filter((s) => oldStrokeIds.includes(s.strokeId));
      eraseLocal(slideId, oldStrokeIds);
      addLocal(newStroke);
      pushUndo({ type: 'replace', slideId, oldStrokes, newStroke });
    },
    [strokes, eraseLocal, addLocal, pushUndo]
  );

  const undo = useCallback(() => {
    if (!currentSlideId) return;
    const stack = undoStacks[currentSlideId] ?? [];
    const cmd = stack[stack.length - 1];
    if (!cmd) return;
    if (cmd.type === 'add') {
      eraseLocal(cmd.stroke.slideId, [cmd.stroke.strokeId]);
    } else if (cmd.type === 'erase') {
      for (const s of cmd.strokes) addLocal(s);
    } else {
      eraseLocal(cmd.slideId, [cmd.newStroke.strokeId]);
      for (const s of cmd.oldStrokes) addLocal(s);
    }
    setUndoStacks((prev) => ({ ...prev, [currentSlideId]: stack.slice(0, -1) }));
    setRedoStacks((prev) => ({ ...prev, [currentSlideId]: [...(prev[currentSlideId] ?? []), cmd] }));
  }, [currentSlideId, undoStacks, eraseLocal, addLocal]);

  const redo = useCallback(() => {
    if (!currentSlideId) return;
    const stack = redoStacks[currentSlideId] ?? [];
    const cmd = stack[stack.length - 1];
    if (!cmd) return;
    if (cmd.type === 'add') {
      addLocal(cmd.stroke);
    } else if (cmd.type === 'erase') {
      eraseLocal(cmd.slideId, cmd.strokes.map((s) => s.strokeId));
    } else {
      eraseLocal(cmd.slideId, cmd.oldStrokes.map((s) => s.strokeId));
      addLocal(cmd.newStroke);
    }
    setRedoStacks((prev) => ({ ...prev, [currentSlideId]: stack.slice(0, -1) }));
    setUndoStacks((prev) => ({ ...prev, [currentSlideId]: [...(prev[currentSlideId] ?? []), cmd] }));
  }, [currentSlideId, redoStacks, eraseLocal, addLocal]);

  const canUndo = ((currentSlideId && undoStacks[currentSlideId]) ?? []).length > 0;
  const canRedo = ((currentSlideId && redoStacks[currentSlideId]) ?? []).length > 0;

  // Ctrl/Cmd+Z で戻す、Ctrl/Cmd+Y または Shift+Ctrl/Cmd+Z でやり直す
  // （テキスト入力欄にフォーカスがある間は入力欄自身の元に戻す機能を優先し、奪わない）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (e.key === 'y' || e.key === 'Y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undo, redo]);

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
    const ids = (strokes[currentSlide.id] ?? []).map((s) => s.strokeId);
    if (ids.length === 0) return;
    onErase(currentSlide.id, ids); // undo/redo履歴に1操作として積む
  }, [currentSlide, strokes, onErase]);

  const reactionMeta = makeReactionMeta(buttons);

  // 直近5分間のボタン反応数（授業タイムライン時刻で判定。サーバとの時計ズレはoffsetで補正）
  const recentCounts = useMemo(() => {
    const clock = lessonClockRef.current;
    const counts: Record<string, number> = {};
    if (!clock.startedAtEpochMs) return counts;
    const nowMs = nowTick + clock.offsetMs - clock.startedAtEpochMs;
    for (const r of reactions) {
      if (r.kind === 'comment') continue;
      if (r.tMs >= nowMs - RECENT_WINDOW_MS) {
        counts[r.kind] = (counts[r.kind] ?? 0) + 1;
      }
    }
    return counts;
  }, [reactions, nowTick]);

  // 授業タイムライン上の現在時刻（タスクの滞留時間の計算に使う）
  const lessonNowMs = useMemo(() => {
    const clock = lessonClockRef.current;
    if (!clock.startedAtEpochMs) return null;
    return nowTick + clock.offsetMs - clock.startedAtEpochMs;
  }, [nowTick]);

  const setTasksRemote = useCallback(
    (list: { id?: string; label: string }[]) => {
      socketRef.current?.emit('set_tasks', { tasks: list }, () => {});
    },
    [socketRef]
  );

  const setTaskConfigRemote = useCallback(
    (p: { mode?: TaskMode; active?: boolean }) => {
      socketRef.current?.emit('set_task_config', p, () => {});
    },
    [socketRef]
  );

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
          <button className="btn header-action" onClick={() => navigate('/dashboard')}>
            授業一覧へ
          </button>
          {!connected && <span className="chip chip-offline">再接続中...</span>}
        </div>
        {/* 参加コード〜授業を開始: 画面が狭いときは横スクロールで1行表示 */}
        <div className="header-right header-scroll">
          <span className="muted nowrap">
            参加コード: <strong className="inline-code">{joinCode}</strong>
          </span>
          <button className="btn header-action" onClick={() => setShowQr(true)} disabled={!joinCode}>
            参加用QR
          </button>
          <span className="muted nowrap">生徒 {participantCount}人</span>
          {screenCount > 0 && <span className="chip chip-live nowrap">大画面 {screenCount}台</span>}
          {status === 'live' && (
            <span className={`nowrap ${audioState === 'on' ? 'rec-on' : 'rec-off'}`}>
              {audioState === 'on' ? '● 録音・配信中' : audioState === 'error' ? 'マイクエラー' : '音声停止中'}
            </span>
          )}
          {status === 'draft' && (
            <button className="btn primary header-action" onClick={startLesson}>
              授業を開始
            </button>
          )}
          {status === 'live' && (
            <>
              {audioState !== 'on' && (
                <button className="btn header-action" onClick={() => void startAudio()}>
                  マイクを開始
                </button>
              )}
              <button className="btn danger header-action" onClick={endLesson}>
                授業を終了
              </button>
            </>
          )}
          {status === 'ended' && (
            <button className="btn header-action" onClick={() => navigate(`/review/${lessonId}`)}>
              振り返りへ
            </button>
          )}
        </div>
      </header>

      {showQr && <JoinQrModal joinCode={joinCode} onClose={() => setShowQr(false)} />}

      <div className="teach-main">
        <div className="slide-area">
          {/* ポインター〜進む: 画面が狭いときは横スクロールで1行表示 */}
          <div className="toolbar">
            <button
              className={`btn tool ${tool === 'pointer' ? 'tool-active' : ''}`}
              onClick={() => setTool((prev) => (prev === 'pointer' ? 'none' : 'pointer'))}
            >
              ポインター
            </button>
            <span className="toolbar-sep" />
            {(
              [
                ['pen', 'ペン'],
                ['text', '文字'],
              ] as [DrawingTool, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                className={`btn tool ${tool === key ? 'tool-active' : ''}`}
                onClick={() => setTool((prev) => (prev === key ? 'none' : key))}
              >
                {label}
              </button>
            ))}
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
            <label className="size-slider" title="ペン・文字のサイズ">
              サイズ
              <input
                type="range"
                min={WIDTH_MIN_STEPS}
                max={WIDTH_MAX_STEPS}
                step={1}
                value={Math.round(lineWidth / WIDTH_UNIT)}
                onChange={(e) => setLineWidth(Number(e.target.value) * WIDTH_UNIT)}
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
            <button
              className={`btn tool ${tool === 'eraser' ? 'tool-active' : ''}`}
              onClick={() => setTool((prev) => (prev === 'eraser' ? 'none' : 'eraser'))}
            >
              消しゴム
            </button>
            <button className="btn tool" onClick={clearCurrentSlide}>
              全消去
            </button>
            <button
              className="btn tool"
              onClick={undo}
              disabled={!canUndo}
              title="元に戻す（Ctrl+Z）"
            >
              ↶ 戻す
            </button>
            <button
              className="btn tool"
              onClick={redo}
              disabled={!canRedo}
              title="やり直す（Ctrl+Y）"
            >
              ↷ 進む
            </button>
          </div>

          <SlideCanvas
            pdf={pdf}
            slide={currentSlide}
            strokes={currentSlideId ? (strokes[currentSlideId] ?? []) : []}
            progressStrokes={currentProgress}
            drawing={{ tool, color, lineWidth, onStroke, onProgress, onPointer, onErase, onReplace }}
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
            {/* 直近のリアクション: 直近5分間のボタン反応数 */}
            <div className="recent-reactions">
              <span className="recent-label">直近のリアクション</span>
              {buttons.map((b) => (
                <span key={b.key} className="kind-pill" style={{ background: b.color }}>
                  {b.label} ×{recentCounts[b.key] ?? 0}
                </span>
              ))}
            </div>
          </div>
        </div>

        <aside className="sidebar">
          {lessonId && (
            <ClassroomPanel
              lessonId={lessonId}
              socketRef={socketRef}
              status={status}
              screenCount={screenCount}
              participants={participants}
              audioDefault={audioDefault}
              cameraOn={cameraOn}
              screenLayout={screenLayout}
              videoToStudents={videoToStudents}
            />
          )}
          <TaskPanel
            tasks={tasks}
            mode={taskMode}
            active={tasksActive}
            progress={taskProgress}
            status={status}
            nowMs={lessonNowMs}
            onSetTasks={setTasksRemote}
            onSetConfig={setTaskConfigRemote}
          />
          <div className="card feed-card">
            <h3>コメント・振り返り</h3>
            <div className="insight-list">
              {insights.length === 0 && (
                <p className="muted">
                  生徒からコメントが届くと、AIが関連する説明の要約とあわせてここに表示します
                </p>
              )}
              {insights.map((p) => (
                <div key={p.id} className="insight-card">
                  {p.comments.map((c) => (
                    <div key={c.reactionId} className="insight-comment">
                      <span className="feed-time">{fmtClock(c.tMs)}</span>
                      <span className="feed-name">{c.participantName}</span>
                      <span className="feed-body">{c.text}</span>
                    </div>
                  ))}
                  {p.status === 'pending' && (
                    <p className="muted small insight-status">AIが関連する説明を分析中...</p>
                  )}
                  {p.status === 'failed' && (
                    <p className="muted small insight-status">関連する説明の分析に失敗しました</p>
                  )}
                  {p.status === 'ready' && (
                    <>
                      <div className="insight-sec">
                        <span className="point-label">関連する説明</span>
                        {p.summary ? (
                          <p className="point-text">{p.summary}</p>
                        ) : (
                          <span className="muted small">録音がないため要約はありません</span>
                        )}
                      </div>
                      <div className="insight-sec">
                        <span className="point-label">周辺の反応</span>
                        {Object.keys(p.kinds).length > 0 ? (
                          <span className="clip-kinds">
                            {Object.entries(p.kinds).map(([k, n]) => (
                              <span
                                key={k}
                                className="kind-pill"
                                style={{ background: reactionMeta.color(k) }}
                              >
                                {reactionMeta.label(k)} ×{n}
                              </span>
                            ))}
                          </span>
                        ) : (
                          <span className="muted small">なし</span>
                        )}
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
