import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type {
  ButtonClip,
  CommentClip,
  LessonStats,
  PointerPayload,
  ReactionButtonDef,
  ReviewChapter,
  ReviewVideo,
  SlideInfo,
  SlideStat,
  StrokePayload,
  TimelineEvent,
} from '@shared';
import { api, ApiError } from '../../lib/api';
import { loadLessonPdf, type PdfCache } from '../../lib/pdf';
import { applyDrawingEvent, type StrokesBySlide } from '../../lib/strokes';
import { fmtClock } from '../../lib/format';
import { makeReactionMeta } from '../../lib/reactionMeta';
import SlideCanvas from '../../components/SlideCanvas';
import SlideThumb from '../../components/SlideThumb';

type LessonDetail = {
  title: string;
  status: string;
  reactionButtons: ReactionButtonDef[];
  slides: SlideInfo[];
  audioDurationMs: number | null;
};

type AudioPart = { file: string; startMs: number };
type Tab = 'reactions' | 'video' | 'slides';
type SlideSort = 'order' | 'comments' | 'buttons' | 'shown';
/** スライド一覧の絞り込み: 全部 / どのブロックにも属さない / 特定のブロックのid */
type SlideFilter = 'all' | 'unassigned' | string;

/** 反応タブ: ボタンとコメントを1本の時系列に混ぜたもの */
type FeedItem =
  | { type: 'button'; at: number; clip: ButtonClip }
  | { type: 'comment'; at: number; clip: CommentClip };

/** 手で足すブロックの既定の長さ */
const NEW_BLOCK_MS = 180_000;
/** 範囲の微調整の刻み */
const TRIM_STEP_MS = 10_000;

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}分${String(s % 60).padStart(2, '0')}秒` : `${s}秒`;
}

export default function Review() {
  const { id: lessonId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [lesson, setLesson] = useState<LessonDetail | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [durationMs, setDurationMs] = useState(0);
  const [buttonClips, setButtonClips] = useState<ButtonClip[]>([]);
  const [commentClips, setCommentClips] = useState<CommentClip[]>([]);
  const [slideStats, setSlideStats] = useState<SlideStat[]>([]);
  const [stats, setStats] = useState<LessonStats | null>(null);
  const [pdf, setPdf] = useState<PdfCache | null>(null);
  const [tab, setTab] = useState<Tab>('reactions');
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [video, setVideo] = useState<ReviewVideo | null>(null);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [slideSort, setSlideSort] = useState<SlideSort>('order');
  const [slideFilter, setSlideFilter] = useState<SlideFilter>('all');
  const [error, setError] = useState('');

  const audioRef = useRef<HTMLAudioElement>(null);
  const currentPartRef = useRef<AudioPart | null>(null);
  const clipEndRef = useRef<number | null>(null);
  const pendingSeekRef = useRef<number | null>(null);

  // ---- データ読み込み ----
  useEffect(() => {
    if (!lessonId) return;
    (async () => {
      try {
        const [detail, tl, bc, cc, ss, st, rv] = await Promise.all([
          api<LessonDetail>(`/api/lessons/${lessonId}`),
          api<{ durationMs: number; events: TimelineEvent[] }>(`/api/lessons/${lessonId}/timeline`),
          api<ButtonClip[]>(`/api/lessons/${lessonId}/button-clips`),
          api<CommentClip[]>(`/api/lessons/${lessonId}/comment-clips`),
          api<SlideStat[]>(`/api/lessons/${lessonId}/slide-stats`),
          api<LessonStats>(`/api/lessons/${lessonId}/stats`),
          api<ReviewVideo>(`/api/lessons/${lessonId}/review-video`),
        ]);
        setLesson(detail);
        setTimeline(tl.events);
        setDurationMs(tl.durationMs || detail.audioDurationMs || 0);
        setButtonClips(bc);
        setCommentClips(cc);
        setSlideStats(ss);
        setStats(st);
        setVideo(rv);
        const cache = await loadLessonPdf(lessonId);
        setPdf(cache);
        // ブロック分けのAIにスライドの内容も渡せるよう、本文を抽出して保存しておく
        if (cache) {
          void cache
            .allPageTexts()
            .then((texts) =>
              api(`/api/lessons/${lessonId}/pdf-text`, {
                method: 'PUT',
                body: JSON.stringify({ texts }),
              })
            )
            .catch(() => {
              /* テキストを持たないPDFもあるので失敗は無視 */
            });
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) navigate('/login');
        else setError('読み込みに失敗しました');
      }
    })();
  }, [lessonId, navigate]);

  const audioParts = useMemo<AudioPart[]>(
    () =>
      timeline
        .filter((e) => e.type === 'audio_part')
        .map((e) => ({ file: (e.payload as { file: string }).file, startMs: e.tMs })),
    [timeline]
  );

  // ---- 再生位置から表示状態（スライド・書き込み・ポインター）を再構成 ----
  const view = useMemo(() => {
    let slideId: string | null = null;
    const strokesBy: StrokesBySlide = {};
    let pointer: PointerPayload | null = null;
    let lastPointerT = -Infinity;
    for (const ev of timeline) {
      if (ev.tMs > playhead) break;
      if (ev.type === 'slide_change') {
        slideId = (ev.payload as { slideId: string }).slideId;
      } else if (ev.type === 'stroke' || ev.type === 'clear_slide') {
        applyDrawingEvent(strokesBy, ev.type, ev.payload as StrokePayload);
      } else if (ev.type === 'pointer') {
        pointer = ev.payload as PointerPayload;
        lastPointerT = ev.tMs;
      }
    }
    if (playhead - lastPointerT > 3000) pointer = null;
    return { slideId, strokesBy, pointer };
  }, [timeline, playhead]);

  const currentSlide = lesson?.slides.find((s) => s.id === view.slideId) ?? null;

  const slideById = useMemo(() => {
    const m = new Map<string, { slide: SlideInfo; no: number }>();
    const sorted = [...(lesson?.slides ?? [])].sort((a, b) => a.position - b.position);
    sorted.forEach((s, i) => m.set(s.id, { slide: s, no: i + 1 }));
    return m;
  }, [lesson]);

  const slideNo = useCallback(
    (slideId: string | null) => (slideId ? (slideById.get(slideId)?.no ?? null) : null),
    [slideById]
  );

  // ---- 音声再生制御（パート跨ぎ・シーク） ----
  const partFor = useCallback(
    (tMs: number): AudioPart | null => {
      let found: AudioPart | null = null;
      for (const p of audioParts) {
        if (p.startMs <= tMs) found = p;
      }
      return found ?? audioParts[0] ?? null;
    },
    [audioParts]
  );

  const seek = useCallback(
    (tMs: number, autoplay = true) => {
      setPlayhead(tMs);
      const audio = audioRef.current;
      const part = partFor(tMs);
      if (!audio || !part || !lessonId) return;
      const offsetSec = Math.max(0, (tMs - part.startMs) / 1000);
      if (currentPartRef.current?.file !== part.file) {
        currentPartRef.current = part;
        pendingSeekRef.current = offsetSec;
        audio.src = `/api/lessons/${lessonId}/audio/${part.file}`;
        audio.load();
        if (autoplay) void audio.play().catch(() => {});
      } else {
        audio.currentTime = offsetSec;
        if (autoplay) void audio.play().catch(() => {});
      }
    },
    [partFor, lessonId]
  );

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onMeta = () => {
      if (pendingSeekRef.current !== null) {
        audio.currentTime = pendingSeekRef.current;
        pendingSeekRef.current = null;
      }
    };
    const onTime = () => {
      const part = currentPartRef.current;
      if (!part) return;
      const t = part.startMs + audio.currentTime * 1000;
      setPlayhead(t);
      if (clipEndRef.current !== null && t >= clipEndRef.current) {
        clipEndRef.current = null;
        audio.pause();
      }
    };
    const onEnded = () => {
      const part = currentPartRef.current;
      if (!part) return;
      const idx = audioParts.findIndex((p) => p.file === part.file);
      const next = audioParts[idx + 1];
      if (next) seek(next.startMs);
      else setPlaying(false);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    return () => {
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
    };
  }, [audioParts, seek]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
    } else {
      clipEndRef.current = null;
      if (!currentPartRef.current) seek(playhead);
      else void audio.play().catch(() => {});
    }
  }, [playing, playhead, seek]);

  const playRange = useCallback(
    (startMs: number, endMs: number) => {
      clipEndRef.current = endMs;
      seek(startMs);
    },
    [seek]
  );

  // ---- コメントの対象箇所をAIで特定 ----
  const analyzeComments = useCallback(async () => {
    if (!lessonId) return;
    setAnalyzing(true);
    setError('');
    try {
      const res = await api<CommentClip[]>(`/api/lessons/${lessonId}/comment-clips/analyze`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setCommentClips(res);
      // 振り分け先のスライドが変わるので集計も取り直す
      setSlideStats(await api<SlideStat[]>(`/api/lessons/${lessonId}/slide-stats`));
    } catch (err) {
      setError(err instanceof Error ? err.message : '解析に失敗しました');
    } finally {
      setAnalyzing(false);
    }
  }, [lessonId]);

  // ---- 復習動画（ブロック） ----
  const applyChapters = useCallback(
    async (chapters: ReviewChapter[]) => {
      setVideo((prev) => (prev ? { ...prev, chapters } : { chapters, shareToken: null, publishedAt: null }));
      // ブロックが変わるとスライドの所属も変わる
      if (lessonId) setSlideStats(await api<SlideStat[]>(`/api/lessons/${lessonId}/slide-stats`));
    },
    [lessonId]
  );

  const generateChapters = useCallback(async () => {
    if (!lessonId) return;
    setGenerating(true);
    setError('');
    try {
      const chapters = await api<ReviewChapter[]>(`/api/lessons/${lessonId}/review-video/generate`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      await applyChapters(chapters);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ブロックの作成に失敗しました');
    } finally {
      setGenerating(false);
    }
  }, [lessonId, applyChapters]);

  const patchChapter = useCallback(
    async (
      chapterId: string,
      patch: Partial<
        Pick<ReviewChapter, 'included' | 'title' | 'description' | 'note' | 'startMs' | 'endMs'>
      >
    ) => {
      if (!lessonId) return;
      try {
        const chapters = await api<ReviewChapter[]>(
          `/api/lessons/${lessonId}/review-video/chapters/${chapterId}`,
          { method: 'PATCH', body: JSON.stringify(patch) }
        );
        await applyChapters(chapters);
      } catch (err) {
        setError(err instanceof Error ? err.message : '更新に失敗しました');
      }
    },
    [lessonId, applyChapters]
  );

  const deleteChapter = useCallback(
    async (chapterId: string) => {
      if (!lessonId) return;
      try {
        const chapters = await api<ReviewChapter[]>(
          `/api/lessons/${lessonId}/review-video/chapters/${chapterId}`,
          { method: 'DELETE' }
        );
        await applyChapters(chapters);
      } catch (err) {
        setError(err instanceof Error ? err.message : '削除に失敗しました');
      }
    },
    [lessonId, applyChapters]
  );

  const addChapter = useCallback(async () => {
    if (!lessonId) return;
    const startMs = Math.max(0, Math.round(playhead));
    const endMs = durationMs > 0 ? Math.min(durationMs, startMs + NEW_BLOCK_MS) : startMs + NEW_BLOCK_MS;
    try {
      const chapters = await api<ReviewChapter[]>(`/api/lessons/${lessonId}/review-video/chapters`, {
        method: 'POST',
        body: JSON.stringify({ startMs, endMs }),
      });
      await applyChapters(chapters);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ブロックの追加に失敗しました');
    }
  }, [lessonId, playhead, durationMs, applyChapters]);

  const redescribeChapter = useCallback(
    async (chapterId: string) => {
      if (!lessonId) return;
      try {
        const chapters = await api<ReviewChapter[]>(
          `/api/lessons/${lessonId}/review-video/chapters/${chapterId}/describe`,
          { method: 'POST', body: JSON.stringify({}) }
        );
        await applyChapters(chapters);
      } catch (err) {
        setError(err instanceof Error ? err.message : '概要の作成に失敗しました');
      }
    },
    [lessonId, applyChapters]
  );

  const moveChapter = useCallback(
    async (index: number, delta: number) => {
      if (!lessonId || !video) return;
      const ids = video.chapters.map((c) => c.id);
      const to = index + delta;
      if (to < 0 || to >= ids.length) return;
      [ids[index], ids[to]] = [ids[to], ids[index]];
      try {
        const chapters = await api<ReviewChapter[]>(`/api/lessons/${lessonId}/review-video/reorder`, {
          method: 'POST',
          body: JSON.stringify({ ids }),
        });
        await applyChapters(chapters);
      } catch (err) {
        setError(err instanceof Error ? err.message : '並び替えに失敗しました');
      }
    },
    [lessonId, video, applyChapters]
  );

  const setPublished = useCallback(
    async (publish: boolean) => {
      if (!lessonId) return;
      setError('');
      try {
        const res = await api<{ shareToken: string | null; publishedAt: string | null }>(
          `/api/lessons/${lessonId}/review-video/${publish ? 'publish' : 'unpublish'}`,
          { method: 'POST', body: JSON.stringify({}) }
        );
        setVideo((prev) => (prev ? { ...prev, ...res } : prev));
      } catch (err) {
        setError(err instanceof Error ? err.message : '公開設定の変更に失敗しました');
      }
    },
    [lessonId]
  );

  const watchUrl = video?.shareToken ? `${window.location.origin}/watch/${video.shareToken}` : '';

  const copyWatchUrl = useCallback(async () => {
    if (!watchUrl) return;
    try {
      await navigator.clipboard.writeText(watchUrl);
    } catch {
      // クリップボードAPIが使えない環境向けのフォールバック
      const ta = document.createElement('textarea');
      ta.value = watchUrl;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [watchUrl]);

  const reactionMeta = useMemo(() => makeReactionMeta(lesson?.reactionButtons ?? []), [lesson]);
  const kindLabel = reactionMeta.label;
  const kindColor = reactionMeta.color;

  // ---- 反応タブ: ボタンとコメントを時系列に混ぜる ----
  const feed = useMemo<FeedItem[]>(
    () =>
      [
        ...buttonClips.map((c) => ({ type: 'button' as const, at: c.startMs, clip: c })),
        ...commentClips.map((c) => ({ type: 'comment' as const, at: c.clipStartMs, clip: c })),
      ].sort((a, b) => a.at - b.at),
    [buttonClips, commentClips]
  );

  // ---- スライドタブ: 絞り込みと並び替え ----
  const chapterLabelById = useMemo(() => {
    const m = new Map<string, string>();
    (video?.chapters ?? []).forEach((c, i) => m.set(c.id, `${i + 1}. ${c.title}`));
    return m;
  }, [video]);

  const visibleSlides = useMemo(() => {
    let rows = [...slideStats];
    if (slideFilter === 'unassigned') rows = rows.filter((s) => s.chapterIds.length === 0);
    else if (slideFilter !== 'all') rows = rows.filter((s) => s.chapterIds.includes(slideFilter));
    const by: Record<SlideSort, (a: SlideStat, b: SlideStat) => number> = {
      order: (a, b) => a.slideNo - b.slideNo,
      comments: (a, b) => b.commentCount - a.commentCount || a.slideNo - b.slideNo,
      buttons: (a, b) => b.buttonCount - a.buttonCount || a.slideNo - b.slideNo,
      shown: (a, b) => b.shownMs - a.shownMs || a.slideNo - b.slideNo,
    };
    return rows.sort(by[slideSort]);
  }, [slideStats, slideFilter, slideSort]);

  if (!lesson) {
    return (
      <div className="page-center">
        <p>{error || '読み込み中...'}</p>
      </div>
    );
  }

  // スクラバー上のマーカー（表示中のタブに対応するもの）
  const markers =
    tab === 'video'
      ? (video?.chapters ?? []).map((c) => ({
          id: c.id,
          at: c.startMs,
          color: c.included ? '#2563eb' : '#9ca3af',
          start: c.startMs,
          end: c.endMs,
        }))
      : feed.map((f) =>
          f.type === 'comment'
            ? {
                id: `c-${f.clip.id}`,
                at: f.clip.clipStartMs,
                color: '#6b7280',
                start: f.clip.clipStartMs,
                end: f.clip.clipEndMs,
              }
            : {
                id: `b-${f.clip.id}`,
                at: (f.clip.startMs + f.clip.endMs) / 2,
                color: kindColor(Object.keys(f.clip.kinds)[0] ?? 'comment'),
                start: f.clip.startMs,
                end: f.clip.endMs,
              }
        );

  const includedChapters = (video?.chapters ?? []).filter((c) => c.included);
  const includedMs = includedChapters.reduce((sum, c) => sum + (c.endMs - c.startMs), 0);

  return (
    <div className="review">
      <header className="app-header">
        <div className="header-left">
          <h1>{lesson.title} — 振り返り</h1>
        </div>
        <div className="header-right">
          <button className="btn" onClick={() => navigate('/dashboard')}>
            授業一覧へ
          </button>
        </div>
      </header>

      {error && <p className="error" style={{ padding: '0 16px' }}>{error}</p>}

      <div className="review-main">
        <div className="review-left">
          <SlideCanvas
            pdf={pdf}
            slide={currentSlide}
            strokes={view.slideId ? (view.strokesBy[view.slideId] ?? []) : []}
            pointer={view.pointer && view.pointer.slideId === view.slideId ? view.pointer : null}
          />

          <div className="player">
            <button className="btn primary" onClick={togglePlay} disabled={audioParts.length === 0}>
              {playing ? '⏸ 一時停止' : '▶ 再生'}
            </button>
            <span className="player-time">
              {fmtClock(playhead)} / {fmtClock(durationMs)}
            </span>
            <div className="scrubber">
              <input
                type="range"
                min={0}
                max={Math.max(durationMs, 1)}
                value={Math.min(playhead, durationMs)}
                onChange={(e) => seek(Number(e.target.value), playing)}
              />
              <div className="scrubber-markers">
                {markers.map((m) => (
                  <button
                    key={m.id}
                    className="cluster-marker"
                    style={{
                      left: `${(m.at / Math.max(durationMs, 1)) * 100}%`,
                      background: m.color,
                    }}
                    title={fmtClock(m.at)}
                    onClick={() => playRange(m.start, m.end)}
                  />
                ))}
              </div>
            </div>
          </div>
          {audioParts.length === 0 && (
            <p className="muted" style={{ textAlign: 'center' }}>
              録音がありません（スライダーでスライド・書き込みの再現のみ可能です）
            </p>
          )}
        </div>

        <div className="review-right">
          <div className="tabs">
            <button
              className={`btn tab ${tab === 'reactions' ? 'tab-active' : ''}`}
              onClick={() => setTab('reactions')}
            >
              反応 ({feed.length})
            </button>
            <button
              className={`btn tab ${tab === 'video' ? 'tab-active' : ''}`}
              onClick={() => setTab('video')}
            >
              復習動画 ({video?.chapters.length ?? 0})
            </button>
            <button
              className={`btn tab ${tab === 'slides' ? 'tab-active' : ''}`}
              onClick={() => setTab('slides')}
            >
              スライド ({slideStats.length})
            </button>
          </div>

          {/* ================= 反応（ボタン・コメント） ================= */}
          {tab === 'reactions' && (
            <div className="panel-scroll">
              {stats && (
                <div className="card">
                  <h3>全体</h3>
                  <p>
                    参加者 <strong>{stats.totalParticipants}</strong>人 ・ 反応{' '}
                    <strong>{stats.totalReactions}</strong>件
                  </p>
                  <div className="clip-kinds">
                    {Object.entries(stats.countsByKind)
                      .filter(([k]) => k !== 'comment')
                      .map(([k, n]) => (
                        <span key={k} className="kind-pill" style={{ background: kindColor(k) }}>
                          {kindLabel(k)} ×{n}
                        </span>
                      ))}
                  </div>
                  <button
                    className="btn"
                    onClick={() => void analyzeComments()}
                    disabled={
                      analyzing || commentClips.length === 0 || commentClips.every((c) => c.analyzed)
                    }
                  >
                    {analyzing
                      ? '解析中...（数分かかることがあります）'
                      : commentClips.length > 0 && commentClips.every((c) => c.analyzed)
                        ? 'コメントは解析済み'
                        : 'AIでコメントの対象箇所を特定'}
                  </button>
                </div>
              )}

              {feed.length === 0 && <p className="muted">生徒からの反応はありませんでした</p>}

              {feed.map((f) =>
                f.type === 'button' ? (
                  <div key={`b-${f.clip.id}`} className="card clip-card">
                    <div className="clip-head">
                      <button
                        className="btn primary"
                        onClick={() => playRange(f.clip.startMs, f.clip.endMs)}
                      >
                        ▶ {fmtClock(f.clip.startMs)}〜{fmtClock(f.clip.endMs)}
                      </button>
                      <strong>{f.clip.participantCount}人が反応</strong>
                      {slideNo(f.clip.slideId) && (
                        <span className="muted">スライド {slideNo(f.clip.slideId)}</span>
                      )}
                    </div>
                    <div className="clip-kinds">
                      {Object.entries(f.clip.kinds).map(([k, n]) => (
                        <span key={k} className="kind-pill" style={{ background: kindColor(k) }}>
                          {kindLabel(k)} ×{n}
                        </span>
                      ))}
                    </div>
                    {/* 個々の反応時刻（薄字） */}
                    <div className="reaction-times">
                      {f.clip.reactions.map((r, i) => (
                        <span
                          key={i}
                          className="reaction-time"
                          title={`${r.name} — ${kindLabel(r.kind)}`}
                        >
                          {fmtClock(r.tMs)} {r.name}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div key={`c-${f.clip.id}`} className="card clip-card clip-card-comment">
                    <div className="clip-head">
                      <button
                        className="btn primary"
                        onClick={() => playRange(f.clip.clipStartMs, f.clip.clipEndMs)}
                      >
                        ▶ {fmtClock(f.clip.clipStartMs)}〜{fmtClock(f.clip.clipEndMs)}
                      </button>
                      {!f.clip.analyzed && <span className="muted small">暫定位置</span>}
                      {slideNo(f.clip.slideId) && (
                        <span className="muted">スライド {slideNo(f.clip.slideId)}</span>
                      )}
                    </div>
                    <p className="clip-comment">
                      💬 {f.clip.participantName}: {f.clip.text}
                    </p>
                    <div className="reaction-times">
                      <span className="reaction-time">送信 {fmtClock(f.clip.tMs)}</span>
                      {f.clip.composeStartMs < f.clip.tMs && (
                        <span className="reaction-time">
                          入力開始 {fmtClock(f.clip.composeStartMs)}
                        </span>
                      )}
                    </div>
                    {f.clip.analyzed &&
                      (f.clip.targetText ? (
                        <div className="clip-target">
                          <span className="point-label">対象の発言</span>
                          <p className="point-text">{f.clip.targetText}</p>
                        </div>
                      ) : (
                        <p className="muted small">
                          このコメントの内容について、先生は授業では話していません。
                        </p>
                      ))}
                  </div>
                )
              )}
            </div>
          )}

          {/* ================= 復習動画（ブロック） ================= */}
          {tab === 'video' && (
            <div className="panel-scroll">
              <div className="card">
                <p className="muted">
                  先生の話とスライドの内容をAIが読み、授業全体を話題のまとまりごとのブロックに分けます。
                  それぞれのブロックだけを見ても内容が分かるように区切られるので、
                  復習させたいブロックだけを選んで公開できます。
                </p>
                <button
                  className="btn primary"
                  onClick={() => void generateChapters()}
                  disabled={generating}
                >
                  {generating
                    ? '区分け中...（数分かかることがあります）'
                    : video && video.chapters.length > 0
                      ? 'ブロックを作り直す'
                      : '授業をブロックに分ける'}
                </button>
              </div>

              {video && video.chapters.length > 0 && (
                <div className="card">
                  <h3>生徒への公開</h3>
                  <p className="muted small">
                    選択中 <strong>{includedChapters.length}</strong>ブロック ・ 合計{' '}
                    <strong>{fmtDur(includedMs)}</strong>
                  </p>
                  {video.shareToken ? (
                    <>
                      <div className="qr-url-row">
                        <code className="watch-url">{watchUrl}</code>
                        <button className="btn" onClick={() => void copyWatchUrl()}>
                          {copied ? 'コピーしました' : 'URLをコピー'}
                        </button>
                      </div>
                      <p className="muted small">
                        公開中（
                        {video.publishedAt && new Date(video.publishedAt).toLocaleString('ja-JP')}）。
                        このページに生徒の名前やコメントは表示されません。
                      </p>
                      <button className="btn" onClick={() => void setPublished(false)}>
                        公開を停止する
                      </button>
                    </>
                  ) : (
                    <>
                      <p className="muted small">
                        公開すると、ログイン不要で見られるURLが作られます。
                      </p>
                      <button className="btn primary" onClick={() => void setPublished(true)}>
                        公開してURLを作る
                      </button>
                    </>
                  )}
                </div>
              )}

              <div className="card">
                <button className="btn" onClick={() => void addChapter()} disabled={durationMs <= 0}>
                  ＋ 現在の再生位置（{fmtClock(playhead)}）からブロックを足す
                </button>
              </div>

              {video?.chapters.length === 0 && (
                <p className="muted">
                  まだブロックがありません。「授業をブロックに分ける」を押してください
                </p>
              )}

              {video?.chapters.map((c, i) => (
                <div key={c.id} className={`card clip-card ${c.included ? '' : 'chapter-excluded'}`}>
                  <div className="clip-head">
                    <button className="btn primary" onClick={() => playRange(c.startMs, c.endMs)}>
                      ▶ {fmtClock(c.startMs)}〜{fmtClock(c.endMs)}
                    </button>
                    <span className="muted small">
                      {i + 1}番目 ・ {fmtDur(c.endMs - c.startMs)}
                    </span>
                  </div>

                  <input
                    className="chapter-title"
                    value={c.title}
                    onChange={(e) =>
                      setVideo((prev) =>
                        prev
                          ? {
                              ...prev,
                              chapters: prev.chapters.map((x) =>
                                x.id === c.id ? { ...x, title: e.target.value } : x
                              ),
                            }
                          : prev
                      )
                    }
                    onBlur={(e) => void patchChapter(c.id, { title: e.target.value })}
                  />

                  {/* ブロックの間に説明していたスライド（複数枚なら複数表示） */}
                  {c.slideIds.length > 0 && (
                    <div className="chapter-slides">
                      {c.slideIds.map((sid) => {
                        const entry = slideById.get(sid);
                        return (
                          <SlideThumb
                            key={sid}
                            pdf={pdf}
                            slide={entry?.slide ?? null}
                            slideNo={entry?.no ?? null}
                            title={`スライド ${entry?.no ?? '?'}`}
                          />
                        );
                      })}
                    </div>
                  )}

                  <label className="chapter-field">
                    <span className="point-label">AIによる概要</span>
                    <textarea
                      className="chapter-textarea"
                      rows={3}
                      value={c.description ?? ''}
                      placeholder="このブロックで何を説明しているか"
                      onChange={(e) =>
                        setVideo((prev) =>
                          prev
                            ? {
                                ...prev,
                                chapters: prev.chapters.map((x) =>
                                  x.id === c.id ? { ...x, description: e.target.value } : x
                                ),
                              }
                            : prev
                        )
                      }
                      onBlur={(e) => void patchChapter(c.id, { description: e.target.value })}
                    />
                  </label>

                  <label className="chapter-field">
                    <span className="point-label">映像に足す補足（生徒に表示されます）</span>
                    <textarea
                      className="chapter-textarea"
                      rows={2}
                      value={c.note ?? ''}
                      placeholder="例: ここは公式の使い方だけ押さえれば大丈夫です"
                      onChange={(e) =>
                        setVideo((prev) =>
                          prev
                            ? {
                                ...prev,
                                chapters: prev.chapters.map((x) =>
                                  x.id === c.id ? { ...x, note: e.target.value } : x
                                ),
                              }
                            : prev
                        )
                      }
                      onBlur={(e) => void patchChapter(c.id, { note: e.target.value })}
                    />
                  </label>

                  <div className="chapter-actions">
                    <label className="chapter-include">
                      <input
                        type="checkbox"
                        checked={c.included}
                        onChange={(e) => void patchChapter(c.id, { included: e.target.checked })}
                      />
                      復習動画に入れる
                    </label>
                    <button className="btn" onClick={() => void moveChapter(i, -1)} disabled={i === 0}>
                      ↑
                    </button>
                    <button
                      className="btn"
                      onClick={() => void moveChapter(i, 1)}
                      disabled={i === video.chapters.length - 1}
                    >
                      ↓
                    </button>
                  </div>

                  <div className="chapter-actions chapter-trim">
                    <span className="muted small">頭</span>
                    <button
                      className="btn"
                      title="10秒前から始める"
                      onClick={() =>
                        void patchChapter(c.id, { startMs: Math.max(0, c.startMs - TRIM_STEP_MS) })
                      }
                    >
                      −10秒
                    </button>
                    <button
                      className="btn"
                      title="頭を10秒詰める"
                      disabled={c.endMs - c.startMs <= TRIM_STEP_MS * 2}
                      onClick={() => void patchChapter(c.id, { startMs: c.startMs + TRIM_STEP_MS })}
                    >
                      ＋10秒
                    </button>
                    <span className="muted small">終わり</span>
                    <button
                      className="btn"
                      title="終わりを10秒詰める"
                      disabled={c.endMs - c.startMs <= TRIM_STEP_MS * 2}
                      onClick={() => void patchChapter(c.id, { endMs: c.endMs - TRIM_STEP_MS })}
                    >
                      −10秒
                    </button>
                    <button
                      className="btn"
                      title="終わりを10秒伸ばす"
                      onClick={() =>
                        void patchChapter(c.id, {
                          endMs:
                            durationMs > 0
                              ? Math.min(durationMs, c.endMs + TRIM_STEP_MS)
                              : c.endMs + TRIM_STEP_MS,
                        })
                      }
                    >
                      ＋10秒
                    </button>
                    <button className="btn" onClick={() => void redescribeChapter(c.id)}>
                      概要を作り直す
                    </button>
                    <button className="btn danger" onClick={() => void deleteChapter(c.id)}>
                      削除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ================= スライド一覧 ================= */}
          {tab === 'slides' && (
            <div className="panel-scroll">
              <div className="card">
                <div className="slide-controls">
                  <label>
                    並び替え
                    <select
                      value={slideSort}
                      onChange={(e) => setSlideSort(e.target.value as SlideSort)}
                    >
                      <option value="order">スライド順</option>
                      <option value="comments">コメント数順</option>
                      <option value="buttons">ボタン反応数順</option>
                      <option value="shown">表示時間順</option>
                    </select>
                  </label>
                  <label>
                    絞り込み
                    <select value={slideFilter} onChange={(e) => setSlideFilter(e.target.value)}>
                      <option value="all">すべて</option>
                      <option value="unassigned">どのブロックにも入っていない</option>
                      {(video?.chapters ?? []).map((c, i) => (
                        <option key={c.id} value={c.id}>
                          {i + 1}. {c.title}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <p className="muted small">
                  コメントとボタン反応は、最も関連すると思われるスライドに振り分けて数えています。
                  「どのブロックにも入っていない」は、ほとんど説明していない（または飛ばした）スライドです。
                </p>
              </div>

              {visibleSlides.length === 0 && <p className="muted">該当するスライドがありません</p>}

              {visibleSlides.map((s) => {
                const entry = slideById.get(s.slideId);
                const jumpTo = s.firstShownMs;
                return (
                  <div key={s.slideId} className="card slide-row">
                    <SlideThumb
                      pdf={pdf}
                      slide={entry?.slide ?? null}
                      slideNo={s.slideNo}
                      title={jumpTo !== null ? `${fmtClock(jumpTo)}へ移動` : '授業では表示していません'}
                      onClick={jumpTo !== null ? () => seek(jumpTo, false) : undefined}
                    />
                    <div className="slide-row-body">
                      <div className="clip-head">
                        <strong>スライド {s.slideNo}</strong>
                        {s.kind === 'blank' && <span className="muted small">白紙</span>}
                        {jumpTo !== null && (
                          <button className="btn" onClick={() => seek(jumpTo, false)}>
                            {fmtClock(jumpTo)}へ
                          </button>
                        )}
                      </div>
                      <p className="muted small">
                        {s.showCount === 0
                          ? '授業では表示していません'
                          : `表示 ${fmtDur(s.shownMs)}${s.showCount > 1 ? `（${s.showCount}回に分かれて）` : ''}`}
                      </p>
                      <div className="clip-kinds">
                        <span className="kind-pill" style={{ background: '#6b7280' }}>
                          コメント {s.commentCount}
                        </span>
                        {Object.entries(s.kinds).map(([k, n]) => (
                          <span key={k} className="kind-pill" style={{ background: kindColor(k) }}>
                            {kindLabel(k)} ×{n}
                          </span>
                        ))}
                      </div>
                      <div className="slide-chapters">
                        {s.chapterIds.length === 0 ? (
                          <span className="muted small">どのブロックにも入っていません</span>
                        ) : (
                          s.chapterIds.map((cid) => (
                            <span key={cid} className="slide-chapter-pill">
                              {chapterLabelById.get(cid) ?? 'ブロック'}
                            </span>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <audio ref={audioRef} style={{ display: 'none' }} />
    </div>
  );
}
