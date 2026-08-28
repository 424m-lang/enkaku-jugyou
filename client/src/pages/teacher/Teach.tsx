import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type {
  AudioFormat,
  CommentInsight,
  LessonStatus,
  ParticipantInfo,
  ReactionButtonDef,
  Poll,
  PollResults,
  PollType,
  ReactionFeedItem,
  StrokePayload,
  StrokeProgressPayload,
  TaskMode,
  TaskProgressEntry,
} from '@shared';
import { api, ApiError } from '../../lib/api';
import { startAudioBroadcast, type AudioBroadcast } from '../../lib/audio';
import { useWakeLock } from '../../lib/useWakeLock';
import { startCaptions } from '../../lib/speech';
import { applyDrawingEvent } from '../../lib/strokes';
import { useLessonLive } from '../../lib/useLessonLive';
import { savePdfTexts } from '../../lib/pdf';
import { fmtClock } from '../../lib/format';
import { makeReactionMeta } from '../../lib/reactionMeta';
import SlideCanvas, { type DrawingTool } from '../../components/SlideCanvas';
import JoinLinkPanel from '../../components/JoinLinkPanel';
import FloatingWindow from '../../components/FloatingWindow';
import MonitorPanel from '../../components/MonitorPanel';
import AudioCaptionPanel from '../../components/AudioCaptionPanel';
import ReactionPanel from '../../components/ReactionPanel';
import TaskPanel from '../../components/TaskPanel';
import PollPanel from '../../components/PollPanel';

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

/**
 * まだ拾っていないカードを上に、その中では新しい順に並べる。
 * 授業中に見るのは「これから答えるもの」なので、済んだものが上に残っていると
 * カードが増えるほど探す手間が増える（対応済みも消さずに下へ残す）
 */
function compareInsights(a: CommentInsight, b: CommentInsight): number {
  if (a.resolved !== b.resolved) return a.resolved ? 1 : -1;
  return insightSortKey(b) - insightSortKey(a);
}

export default function Teach() {
  const { id: lessonId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [joinCode, setJoinCode] = useState('');
  const [reactions, setReactions] = useState<ReactionFeedItem[]>([]);
  const [insights, setInsights] = useState<CommentInsight[]>([]);
  const [taskProgress, setTaskProgress] = useState<TaskProgressEntry[]>([]);
  const [polls, setPolls] = useState<Poll[]>([]);
  const [pollResults, setPollResults] = useState<Record<string, PollResults>>({});
  // いま生徒に見せている集計（締め切ったあとの操作なので、授業を跨いでは持たない）
  const [revealedPollId, setRevealedPollId] = useState<string | null>(null);
  const [participantCount, setParticipantCount] = useState(0);
  const [participants, setParticipants] = useState<ParticipantInfo[]>([]);
  const [screenCount, setScreenCount] = useState(0);
  const [audioState, setAudioState] = useState<'off' | 'on' | 'error'>('off');

  // 操作の合間に暗転すると配信の状態が見えなくなる
  useWakeLock();

  // 対応判定は通ったのに実際には1バイトも作れなかった形式（AACの無音問題など）
  const [audioUnavailable, setAudioUnavailable] = useState<AudioFormat[]>([]);
  // 字幕を作れない・続けられない場合の理由（対応時は null）
  const [captionError, setCaptionError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState('');
  // 道具の窓。閉じている間も中身はDOMに残す（書きかけが消えないように）
  const [windows, setWindows] = useState({
    join: false,
    monitor: false,
    audio: false,
    reaction: false,
    task: false,
    poll: false,
  });
  const toggleWindow = useCallback((key: keyof typeof windows) => {
    setWindows((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const [tool, setTool] = useState<DrawingTool>('pointer');
  const [color, setColor] = useState(COLORS[0].value);
  const [lineWidth, setLineWidth] = useState(WIDTH_DEFAULT);

  // スライドごとのundo/redo履歴（表示中のスライドの操作だけを戻す・やり直す）
  const [undoStacks, setUndoStacks] = useState<Record<string, DrawCommand[]>>({});
  const [redoStacks, setRedoStacks] = useState<Record<string, DrawCommand[]>>({});

  const audioStopRef = useRef<AudioBroadcast | null>(null);
  const audioStartingRef = useRef(false);
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
    reactionsEnabled,
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
    pipPos,
    avFormats,
    audioFormats,
    videoToStudents,
    tasks,
    taskMode,
    tasksActive,
    captionsEnabled,
    captionUsers,
    captionsOnScreen,
    captionsForStudents,
    openPoll,
  } = useLessonLive(lessonId, {
    onLessonState: (st) => {
      lessonClockRef.current = {
        startedAtEpochMs: st.startedAtEpochMs,
        offsetMs: st.serverNowEpochMs - Date.now(),
      };
    },
    setup: (socket) => {
      // 先生画面だけが受け取るイベント
      socket.on('audio_restart', () => audioStopRef.current?.restart());
      socket.on('participant_count', (n) => setParticipantCount(n));
      socket.on('participants', (list) => setParticipants(list));
      // 入退室は1人分だけ届く。id が一致する行を差し替え、無ければ末尾に足す
      // （サーバ側は参加順に並べているので、新しい参加者は末尾で正しい）
      socket.on('participant_changed', (p) =>
        setParticipants((prev) => {
          const i = prev.findIndex((x) => x.id === p.id);
          if (i === -1) return [...prev, p];
          const next = [...prev];
          next[i] = p;
          return next;
        })
      );
      socket.on('screen_count', (n) => setScreenCount(n));
      socket.on('reaction_feed', (item) => {
        // 同じ反応が重複して届いても二重表示しない（再接続時の取りこぼし補完に備える）
        setReactions((prev) =>
          prev.some((r) => r.id === item.id) ? prev : [item, ...prev]
        );
      });
      // コメント・振り返り（コメント到着時とAI分析完成時に同じidで届く → 上書き）
      socket.on('comment_insight', (p) => {
        setInsights((prev) => [p, ...prev.filter((x) => x.id !== p.id)].sort(compareInsights));
      });
      // 既存カードへ統合されて不要になったカードを取り除く
      socket.on('comment_insight_removed', (id) => {
        setInsights((prev) => prev.filter((x) => x.id !== id));
      });
      // アンケート（設問一覧と集計は先生にだけ届く）
      socket.on('polls_updated', (list) => setPolls(list));
      socket.on('poll_results', (r) => setPollResults((prev) => ({ ...prev, [r.pollId]: r })));
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
        setInsights([...ins].sort(compareInsights));
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

  // ---- 自動字幕 ----
  // 先生の端末のブラウザ音声認識を、授業中かつONの間だけ動かして文字を配る。
  // サーバ側の文字起こしは10秒以上遅れて教室の字幕には使えないため、
  // ライブはこちらで賄い、用語の正しい版は履歴側でWhisperに差し替える。
  // 字幕は生徒がONにしても始まるので、動かなかったことは生徒にも伝える。
  // でないと「出るはずの字幕が出てこない」理由が生徒側から分からない
  const reportCaptionStatus = useCallback(
    (unavailable: boolean) => socketRef.current?.emit('set_caption_status', { unavailable }),
    [socketRef]
  );

  useEffect(() => {
    if (status !== 'live' || !captionsEnabled) return;
    const src = startCaptions({
      onText: (text, final) => socketRef.current?.emit('caption', { text, final }),
      onFatal: (err) => {
        setCaptionError(err);
        reportCaptionStatus(true);
      },
    });
    if (!src) {
      setCaptionError('unsupported');
      reportCaptionStatus(true);
      return;
    }
    setCaptionError(null);
    reportCaptionStatus(false);
    return () => src.stop();
  }, [status, captionsEnabled, socketRef, reportCaptionStatus]);

  // 「直近のリアクション」: 授業中は30秒ごとに再集計して窓から外れた反応を落とす
  useEffect(() => {
    if (status !== 'live') return;
    const timer = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [status]);

  // ---- 操作 ----
  const startAudio = useCallback(async () => {
    // await の間に2回目が入ると、マイクが2本開いて声が二重に流れる
    if (audioStopRef.current || audioStartingRef.current) return;
    audioStartingRef.current = true;
    try {
      const socket = socketRef.current;
      if (!socket) return;
      setAudioUnavailable([]);
      audioStopRef.current = await startAudioBroadcast(socket, audioFormats, {
        onUnavailable: (format) =>
          setAudioUnavailable((prev) => (prev.includes(format) ? prev : [...prev, format])),
        onAvailable: (format) => setAudioUnavailable((prev) => prev.filter((f) => f !== format)),
      });
      setAudioState('on');
    } catch {
      setAudioState('error');
    } finally {
      audioStartingRef.current = false;
    }
  }, [socketRef, audioFormats]);

  // 受け手の出入りで必要形式が変わっても、マイクは取り直さず録音器だけ足し引きする
  useEffect(() => {
    audioStopRef.current?.setFormats(audioFormats);
  }, [audioFormats]);

  // 授業中にこの画面を開き直した（再読み込み・端末チェックから戻った）ときは、
  // マイクが止まったままにならないよう入れ直す。止まっていることに先生が
  // 気づけないまま授業が進むのが一番まずいため、既定で復帰させる
  useEffect(() => {
    if (status !== 'live' || audioStopRef.current) return;
    void startAudio();
  }, [status, startAudio]);

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
    (p: StrokeProgressPayload) => {
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

  // コメントが「どのスライドを見ながら書かれたか」。授業中に戻って説明し直す判断に使う
  const slideNoOf = useCallback(
    (slideId: string | null): number | null => {
      if (!slideId) return null;
      const i = sortedSlides.findIndex((sl) => sl.id === slideId);
      return i >= 0 ? i + 1 : null;
    },
    [sortedSlides]
  );

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

  // まだ拾っていないコメントの数。カードが増えても取りこぼしに気づけるようにする
  const openInsightCount = insights.filter((p) => !p.resolved).length;

  // ボタンを開かなくても反応があったことに気づけるよう、合計だけ外に出す
  const recentTotal = useMemo(
    () => Object.values(recentCounts).reduce((a, b) => a + b, 0),
    [recentCounts]
  );

  // 授業タイムライン上の現在時刻（タスクの滞留時間の計算に使う）
  const lessonNowMs = useMemo(() => {
    const clock = lessonClockRef.current;
    if (!clock.startedAtEpochMs) return null;
    return nowTick + clock.offsetMs - clock.startedAtEpochMs;
  }, [nowTick]);

  const setReactionsEnabledRemote = useCallback(
    (enabled: boolean) => {
      socketRef.current?.emit('set_reactions_enabled', { enabled }, () => {});
    },
    [socketRef]
  );

  // 「対応済み」の印。消さずに印だけ付けて、下へ送る
  const setInsightResolved = useCallback(
    (insightId: string, resolved: boolean) => {
      socketRef.current?.emit('set_insight_resolved', { insightId, resolved }, () => {});
    },
    [socketRef]
  );

  const setReactionButtonsRemote = useCallback(
    (list: ReactionButtonDef[]) => {
      socketRef.current?.emit('set_reaction_buttons', { buttons: list }, (res) => {
        if (!res.ok && res.error) window.alert(res.error);
      });
    },
    [socketRef]
  );

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

  const savePoll = useCallback(
    (p: {
      id?: string;
      question: string;
      type: PollType;
      options?: { id?: string; label: string }[];
      minLabel?: string | null;
      maxLabel?: string | null;
    }) => {
      socketRef.current?.emit('save_poll', p, (res) => {
        if (!res.ok && res.error) window.alert(res.error);
      });
    },
    [socketRef]
  );

  const deletePoll = useCallback(
    (pollId: string) => socketRef.current?.emit('delete_poll', { pollId }, () => {}),
    [socketRef]
  );
  const openPollRemote = useCallback(
    (pollId: string) =>
      socketRef.current?.emit('open_poll', { pollId }, (res) => {
        if (!res.ok && res.error) window.alert(res.error);
      }),
    [socketRef]
  );
  // 同じ質問をもう一度聞く。同じ設問を開き直すと前回の回答が残ったままになり
  // 集計が古い票と混ざるため、新しい設問として複製してから開く
  const repeatPoll = useCallback(
    (poll: Poll) => {
      socketRef.current?.emit(
        'save_poll',
        {
          question: poll.question,
          type: poll.type,
          options: poll.options.map((o) => ({ label: o.label })),
          minLabel: poll.minLabel,
          maxLabel: poll.maxLabel,
        },
        (res) => {
          if (res.ok && res.poll) {
            socketRef.current?.emit('open_poll', { pollId: res.poll.id }, () => {});
          } else if (res.error) {
            window.alert(res.error);
          }
        }
      );
    },
    [socketRef]
  );

  const closePollRemote = useCallback(
    (pollId: string) => {
      socketRef.current?.emit('close_poll', { pollId }, () => {});
      setRevealedPollId(null);
    },
    [socketRef]
  );

  // 締め切ったあとに結果を出す・引っ込める（集計を見てから決められるように分けてある）
  const revealPollRemote = useCallback(
    (pollId: string, reveal: boolean) => {
      socketRef.current?.emit('reveal_poll', { pollId, reveal }, (res) => {
        if (!res.ok) {
          if (res.error) window.alert(res.error);
          return;
        }
        setRevealedPollId(reveal ? pollId : null);
      });
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
          {/* 3つとも同じ「開くと窓が出る」ボタンなので、大きさを揃えて1組に見せる */}
          <div className="header-tools">
            <button
              className={`btn header-action ${windows.join ? 'header-action-on' : ''}`}
              onClick={() => toggleWindow('join')}
              disabled={!joinCode}
            >
              参加用リンク
            </button>
            <button
              className={`btn header-action ${windows.monitor ? 'header-action-on' : ''}`}
              onClick={() => toggleWindow('monitor')}
            >
              教室モニター設定
            </button>
            <button
              className={`btn header-action ${windows.audio ? 'header-action-on' : ''}`}
              onClick={() => toggleWindow('audio')}
            >
              音声・字幕設定
            </button>
          </div>
          <span className="muted nowrap">生徒 {participantCount}人</span>
          {screenCount > 0 && (
            <span className="chip chip-live nowrap">教室モニター {screenCount}台</span>
          )}
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

      {audioUnavailable.length > 0 && (
        <div className="teach-format-warn" role="alert">
          <div>
            <strong>一部の音声形式を作れません</strong>
            <span>
              {audioUnavailable.includes('mp4')
                ? 'AAC音声が生成されなかったため、AACだけに対応する端末では音が出ません。'
                : 'Opus音声が生成されなかったため、AACへ切り替えて録音・配信を続けています。'}
              {' '}各端末での可否は <a href="/check" target="_blank" rel="noreferrer">/check</a> で確認できます。
            </span>
          </div>
        </div>
      )}

      {captionsEnabled && captionError && (
        <div className="teach-format-warn" role="alert">
          <div>
            <strong>字幕を作れません</strong>
            <span>
              {captionError === 'unsupported'
                ? 'このブラウザは音声認識に対応していません。Chrome または Edge で開き直してください。'
                : 'マイクの利用が許可されませんでした。ブラウザの設定を確認してください。'}
            </span>
          </div>
        </div>
      )}

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
            {/* 授業中に出し入れする道具。窓は開いたままスライドを送れる */}
            <div className="tool-windows">
              <button
                className={`btn tool-window-btn ${windows.reaction ? 'tool-active' : ''}`}
                onClick={() => toggleWindow('reaction')}
              >
                リアクションボタン
                {reactionsEnabled && recentTotal > 0 && (
                  <span className="tool-window-badge">{recentTotal}</span>
                )}
              </button>
              <button
                className={`btn tool-window-btn ${windows.task ? 'tool-active' : ''}`}
                onClick={() => toggleWindow('task')}
              >
                タスク
                {tasksActive && <span className="tool-window-badge">表示中</span>}
              </button>
              <button
                className={`btn tool-window-btn ${windows.poll ? 'tool-active' : ''}`}
                onClick={() => toggleWindow('poll')}
              >
                アンケート
                {openPoll && <span className="tool-window-badge">回答中</span>}
              </button>
            </div>
          </div>
        </div>

        {/* サイドバーはコメント・振り返り専用。授業中に一番読みたいものが
            他のパネルに押し下げられて見えなくなっていたため、他は窓へ出した */}
        <aside className="sidebar">
          <div className="card feed-card">
            <h3>
              コメント・振り返り
              {openInsightCount > 0 && <span className="feed-count">{openInsightCount}</span>}
              {insights.length > 0 && openInsightCount === 0 && (
                <span className="feed-count feed-count-done">すべて対応済み</span>
              )}
            </h3>
            <div className="insight-list">
              {insights.length === 0 && (
                <p className="muted">
                  生徒からコメントが届くと、AIが関連する説明の要約とあわせてここに表示します
                </p>
              )}
              {insights.map((p) => (
                <div key={p.id} className={p.resolved ? 'insight-card resolved' : 'insight-card'}>
                  {slideNoOf(p.slideId) && (
                    <span className="insight-slide">
                      スライド {slideNoOf(p.slideId)}
                      {slideNoOf(p.slideId) !== currentIndex + 1 && (
                        <button
                          className="btn-link"
                          onClick={() => p.slideId && changeSlideTo(p.slideId)}
                          title="そのスライドへ戻ります（生徒の画面も動きます）"
                        >
                          そこへ戻る
                        </button>
                      )}
                    </span>
                  )}
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
                      {/* 周辺の反応は、あったときだけ出す（「なし」は読む手間だけ増やす） */}
                      {Object.keys(p.kinds).length > 0 && (
                        <div className="insight-sec">
                          <span className="point-label">周辺の反応</span>
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
                        </div>
                      )}
                    </>
                  )}
                  <div className="insight-actions">
                    <button
                      className={p.resolved ? 'btn-link' : 'btn small'}
                      onClick={() => setInsightResolved(p.id, !p.resolved)}
                      title={
                        p.resolved
                          ? 'まだ拾えていない扱いに戻します'
                          : 'このコメントは拾ったという印を付けます（記録は残ります）'
                      }
                    >
                      {p.resolved ? '✓ 対応済み（戻す）' : '対応済みにする'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>

      <FloatingWindow
        title="参加用リンク"
        open={windows.join}
        onClose={() => toggleWindow('join')}
        defaultPos={{ x: 40, y: 80 }}
        width={440}
      >
        <JoinLinkPanel joinCode={joinCode} />
      </FloatingWindow>

      {lessonId && (
        <FloatingWindow
          title="教室モニター設定"
          open={windows.monitor}
          onClose={() => toggleWindow('monitor')}
          defaultPos={{ x: 60, y: 96 }}
          width={520}
        >
          <MonitorPanel
            lessonId={lessonId}
            socketRef={socketRef}
            screenCount={screenCount}
            cameraOn={cameraOn}
            screenLayout={screenLayout}
            pipPos={pipPos}
            avFormats={avFormats}
            videoToStudents={videoToStudents}
          />
        </FloatingWindow>
      )}

      <FloatingWindow
        title="音声・字幕設定"
        open={windows.audio}
        onClose={() => toggleWindow('audio')}
        defaultPos={{ x: 110, y: 130 }}
      >
        <AudioCaptionPanel
          socketRef={socketRef}
          status={status}
          screenCount={screenCount}
          participants={participants}
          audioDefault={audioDefault}
          captionsOnScreen={captionsOnScreen}
          captionsForStudents={captionsForStudents}
          captionUsers={captionUsers}
        />
      </FloatingWindow>

      <FloatingWindow
        title="リアクションボタン"
        open={windows.reaction}
        onClose={() => toggleWindow('reaction')}
        defaultPos={{ x: 160, y: 164 }}
      >
        <ReactionPanel
          buttons={buttons}
          enabled={reactionsEnabled}
          recentCounts={recentCounts}
          onSetEnabled={setReactionsEnabledRemote}
          onSetButtons={setReactionButtonsRemote}
        />
      </FloatingWindow>

      <FloatingWindow
        title="タスク"
        open={windows.task}
        onClose={() => toggleWindow('task')}
        defaultPos={{ x: 210, y: 198 }}
      >
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
      </FloatingWindow>

      <FloatingWindow
        title="アンケート"
        open={windows.poll}
        onClose={() => toggleWindow('poll')}
        defaultPos={{ x: 260, y: 232 }}
        width={420}
      >
        <PollPanel
          polls={polls}
          results={pollResults}
          openPollId={openPoll?.id ?? null}
          revealedPollId={revealedPollId}
          status={status}
          onSave={savePoll}
          onDelete={deletePoll}
          onOpen={openPollRemote}
          onRepeat={repeatPoll}
          onClose={closePollRemote}
          onReveal={revealPollRemote}
        />
      </FloatingWindow>
    </div>
  );
}
