import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type {
  ButtonClip,
  CommentClip,
  LessonStats,
  PointerPayload,
  ReactionButtonDef,
  SlideInfo,
  StrokePayload,
  TimelineEvent,
} from '@shared';
import { api, ApiError } from '../../lib/api';
import { loadLessonPdf, type PdfCache } from '../../lib/pdf';
import { applyDrawingEvent, type StrokesBySlide } from '../../lib/strokes';
import { fmtClock } from '../../lib/format';
import { makeReactionMeta } from '../../lib/reactionMeta';
import SlideCanvas from '../../components/SlideCanvas';

type LessonDetail = {
  title: string;
  status: string;
  reactionButtons: ReactionButtonDef[];
  slides: SlideInfo[];
  audioDurationMs: number | null;
};

type AudioPart = { file: string; startMs: number };
type Tab = 'buttons' | 'comments' | 'video';

export default function Review() {
  const { id: lessonId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [lesson, setLesson] = useState<LessonDetail | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [durationMs, setDurationMs] = useState(0);
  const [buttonClips, setButtonClips] = useState<ButtonClip[]>([]);
  const [commentClips, setCommentClips] = useState<CommentClip[]>([]);
  const [stats, setStats] = useState<LessonStats | null>(null);
  const [pdf, setPdf] = useState<PdfCache | null>(null);
  const [tab, setTab] = useState<Tab>('buttons');
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
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
        const [detail, tl, bc, cc, st] = await Promise.all([
          api<LessonDetail>(`/api/lessons/${lessonId}`),
          api<{ durationMs: number; events: TimelineEvent[] }>(`/api/lessons/${lessonId}/timeline`),
          api<ButtonClip[]>(`/api/lessons/${lessonId}/button-clips`),
          api<CommentClip[]>(`/api/lessons/${lessonId}/comment-clips`),
          api<LessonStats>(`/api/lessons/${lessonId}/stats`),
        ]);
        setLesson(detail);
        setTimeline(tl.events);
        setDurationMs(tl.durationMs || detail.audioDurationMs || 0);
        setButtonClips(bc);
        setCommentClips(cc);
        setStats(st);
        setPdf(await loadLessonPdf(lessonId));
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
    } catch (err) {
      setError(err instanceof Error ? err.message : '解析に失敗しました');
    } finally {
      setAnalyzing(false);
    }
  }, [lessonId]);

  const reactionMeta = useMemo(() => makeReactionMeta(lesson?.reactionButtons ?? []), [lesson]);
  const kindLabel = reactionMeta.label;
  const kindColor = reactionMeta.color;

  const slideNo = useCallback(
    (slideId: string | null) => {
      if (!slideId || !lesson) return null;
      const sorted = [...lesson.slides].sort((a, b) => a.position - b.position);
      const idx = sorted.findIndex((s) => s.id === slideId);
      return idx >= 0 ? idx + 1 : null;
    },
    [lesson]
  );

  if (!lesson) {
    return (
      <div className="page-center">
        <p>{error || '読み込み中...'}</p>
      </div>
    );
  }

  // スクラバー上のマーカー（表示中のタブに対応するもの）
  const markers =
    tab === 'comments'
      ? commentClips.map((c) => ({ id: c.id, at: c.clipStartMs, color: '#6b7280', start: c.clipStartMs, end: c.clipEndMs }))
      : buttonClips.map((c) => ({
          id: c.id,
          at: (c.startMs + c.endMs) / 2,
          color: kindColor(Object.keys(c.kinds)[0] ?? 'comment'),
          start: c.startMs,
          end: c.endMs,
        }));

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
            <button className={`btn tab ${tab === 'buttons' ? 'tab-active' : ''}`} onClick={() => setTab('buttons')}>
              ボタン ({buttonClips.length})
            </button>
            <button className={`btn tab ${tab === 'comments' ? 'tab-active' : ''}`} onClick={() => setTab('comments')}>
              コメント ({commentClips.length})
            </button>
            <button className={`btn tab ${tab === 'video' ? 'tab-active' : ''}`} onClick={() => setTab('video')}>
              復習動画
            </button>
          </div>

          {tab === 'buttons' && (
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
                </div>
              )}
              {buttonClips.length === 0 && <p className="muted">ボタンによる反応はありませんでした</p>}
              {buttonClips.map((c) => (
                <div key={c.id} className="card clip-card">
                  <div className="clip-head">
                    <button className="btn primary" onClick={() => playRange(c.startMs, c.endMs)}>
                      ▶ {fmtClock(c.startMs)}〜{fmtClock(c.endMs)}
                    </button>
                    <strong>{c.participantCount}人が反応</strong>
                    {slideNo(c.slideId) && <span className="muted">スライド {slideNo(c.slideId)}</span>}
                  </div>
                  <div className="clip-kinds">
                    {Object.entries(c.kinds).map(([k, n]) => (
                      <span key={k} className="kind-pill" style={{ background: kindColor(k) }}>
                        {kindLabel(k)} ×{n}
                      </span>
                    ))}
                  </div>
                  {/* 個々の反応時刻（薄字） */}
                  <div className="reaction-times">
                    {c.reactions.map((r, i) => (
                      <span key={i} className="reaction-time" title={`${r.name} — ${kindLabel(r.kind)}`}>
                        {fmtClock(r.tMs)} {r.name}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === 'comments' && (
            <div className="panel-scroll">
              <div className="card">
                <p className="muted">
                  コメントと、その前の先生の説明をAIが照合し、コメントが向けられた発言の位置にクリップを作ります。
                </p>
                <button
                  className="btn primary"
                  onClick={() => void analyzeComments()}
                  disabled={analyzing || commentClips.length === 0 || commentClips.every((c) => c.analyzed)}
                >
                  {analyzing
                    ? '解析中...（数分かかることがあります）'
                    : commentClips.every((c) => c.analyzed) && commentClips.length > 0
                      ? '解析済み'
                      : 'AIでコメントの対象箇所を特定'}
                </button>
              </div>
              {commentClips.length === 0 && <p className="muted">コメントはありませんでした</p>}
              {commentClips.map((c) => (
                <div key={c.id} className="card clip-card">
                  <div className="clip-head">
                    <button className="btn primary" onClick={() => playRange(c.clipStartMs, c.clipEndMs)}>
                      ▶ {fmtClock(c.clipStartMs)}〜{fmtClock(c.clipEndMs)}
                    </button>
                    {!c.analyzed && <span className="muted small">暫定位置</span>}
                    {slideNo(c.slideId) && <span className="muted">スライド {slideNo(c.slideId)}</span>}
                  </div>
                  <p className="clip-comment">💬 {c.participantName}: {c.text}</p>
                  {/* コメント送信時刻（薄字） */}
                  <div className="reaction-times">
                    <span className="reaction-time">送信 {fmtClock(c.tMs)}</span>
                    {c.composeStartMs < c.tMs && (
                      <span className="reaction-time">入力開始 {fmtClock(c.composeStartMs)}</span>
                    )}
                  </div>
                  {c.targetText && (
                    <div className="clip-target">
                      <span className="point-label">対象の発言</span>
                      <p className="point-text">{c.targetText}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {tab === 'video' && (
            <div className="panel-scroll">
              <div className="card">
                <h3>復習動画</h3>
                <p className="muted">
                  「ボタン」「コメント」で見つかった、生徒がつまずいた箇所をつなげて、
                  授業に出られなかった生徒も見られる復習用の再生ページを作る機能です。現在設計中です。
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      <audio ref={audioRef} style={{ display: 'none' }} />
    </div>
  );
}
