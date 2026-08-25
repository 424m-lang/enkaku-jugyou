import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AudioMode,
  LessonStatus,
  LessonTask,
  LiveLessonState,
  PipPos,
  PublicPoll,
  ReactionButtonDef,
  ScreenLayout,
  SlideInfo,
  StrokePayload,
  TaskMode,
  VideoFormat,
} from '@shared';
import { DEFAULT_PIP_POS } from '@shared';
import { connectLessonSocket, type AppSocket } from './socket';
import { loadLessonPdf, type PdfCache } from './pdf';
import { rebuildStrokes, applyDrawingEvent, type StrokesBySlide } from './strokes';

type Options = {
  /** 教室モニターとして接続する場合のトークン（先生のログイン不要） */
  screenToken?: string;
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
  // ボタンを使わない授業では false（定義は残るので、戻せば元のボタンが復活する）
  const [reactionsEnabled, setReactionsEnabled] = useState(true);
  const [slides, setSlides] = useState<SlideInfo[]>([]);
  const [currentSlideId, setCurrentSlideId] = useState<string | null>(null);
  const [strokes, setStrokes] = useState<StrokesBySlide>({});
  const [remoteProgress, setRemoteProgress] = useState<Record<string, StrokePayload>>({});
  const [pdf, setPdf] = useState<PdfCache | null>(null);
  // 教室モニターまわり。3画面すべてが同じ状態を見る必要がある
  const [audioDefault, setAudioDefault] = useState<AudioMode>('on');
  const [cameraOn, setCameraOn] = useState(false);
  const [avHasAudio, setAvHasAudio] = useState(false);
  const [screenLayout, setScreenLayout] = useState<ScreenLayout>('slide');
  const [videoToStudents, setVideoToStudents] = useState(false);
  const [pipPos, setPipPos] = useState<PipPos>(DEFAULT_PIP_POS);
  // 受け手全員に届く形式のうち、いちばん遅れの少ないもの（サーバが判断して伝えてくる）
  const [avFormat, setAvFormat] = useState<VideoFormat>('webm');
  // タスク。誰がどこまで進んだかはここには入らない（進捗は画面ごとに別イベントで受ける）
  const [tasks, setTasks] = useState<LessonTask[]>([]);
  const [taskMode, setTaskMode] = useState<TaskMode>('sequential');
  const [tasksActive, setTasksActive] = useState(false);
  const [captionsEnabled, setCaptionsEnabled] = useState(false);
  // 字幕の出し先。作るかどうかはこの2つから決まる
  const [captionsOnScreen, setCaptionsOnScreen] = useState(false);
  const [captionsForStudents, setCaptionsForStudents] = useState(false);
  // いま開いているアンケート（開始・締め切りは全画面が同じ状態を見る）
  const [openPoll, setOpenPoll] = useState<PublicPoll | null>(null);

  useEffect(() => {
    if (!lessonId) return;
    let disposed = false;

    void loadLessonPdf(lessonId).then((cache) => {
      if (!disposed) setPdf(cache);
    });

    const socket = connectLessonSocket(lessonId, optionsRef.current.screenToken);
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));

    // 参加・再接続時にサーバから届く状態スナップショット
    socket.on('lesson_state', (st) => {
      setTitle(st.title);
      setStatus(st.status);
      setButtons(st.reactionButtons);
      setReactionsEnabled(st.reactionsEnabled);
      setSlides(st.slides);
      setCurrentSlideId((cur) => st.currentSlideId ?? cur ?? st.slides[0]?.id ?? null);
      setStrokes(rebuildStrokes(st.drawingEvents));
      setAudioDefault(st.audioDefault);
      setTasks(st.tasks);
      setTaskMode(st.taskMode);
      setTasksActive(st.tasksActive);
      setCaptionsEnabled(st.captionsEnabled);
      setCaptionsOnScreen(st.captionsOnScreen);
      setCaptionsForStudents(st.captionsForStudents);
      setOpenPoll(st.openPoll);
      optionsRef.current.onLessonState?.(st);
    });

    socket.on('av_state', (p) => {
      setCameraOn(p.cameraOn);
      setAvHasAudio(p.avHasAudio);
      setScreenLayout(p.layout);
      setVideoToStudents(p.videoToStudents);
      if (p.pipPos) setPipPos(p.pipPos);
    });

    socket.on('av_format', (p) => setAvFormat(p.format));

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
    socket.on('lesson_started', () => setStatus('live'));
    socket.on('lesson_ended', () => setStatus('ended'));
    socket.on('poll_open', (poll) => setOpenPoll(poll));
    socket.on('poll_closed', (p) => setOpenPoll((cur) => (cur?.id === p.pollId ? null : cur)));

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
    reactionsEnabled,
    slides,
    setSlides,
    sortedSlides,
    currentSlideId,
    setCurrentSlideId,
    currentSlide,
    strokes,
    setStrokes,
    currentProgress,
    pdf,
    audioDefault,
    cameraOn,
    avHasAudio,
    screenLayout,
    videoToStudents,
    pipPos,
    avFormat,
    tasks,
    taskMode,
    tasksActive,
    captionsEnabled,
    captionsOnScreen,
    captionsForStudents,
    openPoll,
  };
}
