import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type {
  FullTranscriptSummary,
  LessonStats,
  PointerPayload,
  ReactionButtonDef,
  ReactionCluster,
  SlideInfo,
  StrokePayload,
  TimelineEvent,
} from '@shared';
import { api, ApiError } from '../../lib/api';
import { loadLessonPdf, type PdfCache } from '../../lib/pdf';
import { applyDrawingEvent, type StrokesBySlide } from '../../lib/strokes';
import SlideCanvas from '../../components/SlideCanvas';

type LessonDetail = {
  title: string;
  status: string;
  reactionButtons: ReactionButtonDef[];
  slides: SlideInfo[];
  audioDurationMs: number | null;
};

type AudioPart = { file: string; startMs: number };

function fmt(tMs: number): string {
  const s = Math.max(0, Math.floor(tMs / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function Review() {
  const { id: lessonId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [lesson, setLesson] = useState<LessonDetail | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [durationMs, setDurationMs] = useState(0);
  const [clips, setClips] = useState<ReactionCluster[]>([]);
  const [stats, setStats] = useState<LessonStats | null>(null);
  const [summary, setSummary] = useState<FullTranscriptSummary | null>(null);
  const [pdf, setPdf] = useState<PdfCache | null>(null);
  const [tab, setTab] = useState<'clips' | 'summary' | 'stats'>('clips');
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [generating, setGenerating] = useState(false);
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
        const [detail, tl, cl, st] = await Promise.all([
          api<LessonDetail>(`/api/lessons/${lessonId}`),
          api<{ durationMs: number; events: TimelineEvent[] }>(`/api/lessons/${lessonId}/timeline`),
          api<ReactionCluster[]>(`/api/lessons/${lessonId}/clips`),
          api<LessonStats>(`/api/lessons/${lessonId}/stats`),
        ]);
        setLesson(detail);
        setTimeline(tl.events);
        setDurationMs(tl.durationMs || detail.audioDurationMs || 0);
        setClips(cl);
        setStats(st);
        setPdf(await loadLessonPdf(lessonId));
        try {
          setSummary(await api<FullTranscriptSummary>(`/api/lessons/${lessonId}/summary`));
        } catch {
          /* まだ要約なし */
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

  const playClip = useCallback(
    (c: ReactionCluster) => {
      clipEndRef.current = c.endMs;
      seek(c.startMs);
    },
    [seek]
  );

  // ---- 要約生成 ----
  const generateSummary = useCallback(async () => {
    if (!lessonId) return;
    setGenerating(true);
    setError('');
    try {
      const res = await api<FullTranscriptSummary>(`/api/lessons/${lessonId}/summarize`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setSummary(res);
      // 話速が計算できるようになったので統計を再取得
      setStats(await api<LessonStats>(`/api/lessons/${lessonId}/stats`));
    } catch (err) {
      setError(err instanceof Error ? err.message : '要約の生成に失敗しました');
    } finally {
      setGenerating(false);
    }
  }, [lessonId]);

  const transcribeClip = useCallback(
    async (c: ReactionCluster) => {
      if (!lessonId) return;
      try {
        const res = await api<{ text: string }>(`/api/lessons/${lessonId}/clips/transcribe`, {
          method: 'POST',
          body: JSON.stringify({ startMs: c.startMs, endMs: c.endMs }),
        });
        setClips((prev) =>
          prev.map((x) => (x.id === c.id ? { ...x, transcriptText: res.text } : x))
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : '文字起こしに失敗しました');
      }
    },
    [lessonId]
  );

  const kindLabel = useCallback(
    (kind: string) =>
      kind === 'comment' ? 'コメント' : (lesson?.reactionButtons.find((b) => b.key === kind)?.label ?? kind),
    [lesson]
  );
  const kindColor = useCallback(
    (kind: string) =>
      kind === 'comment' ? '#6b7280' : (lesson?.reactionButtons.find((b) => b.key === kind)?.color ?? '#6b7280'),
    [lesson]
  );

  if (!lesson) {
    return (
      <div className="page-center">
        <p>{error || '読み込み中...'}</p>
      </div>
    );
  }

  const maxTimelineTotal = Math.max(1, ...(stats?.timeline.map((t) => t.total) ?? [1]));
  const maxRate = Math.max(1, ...(stats?.speechRate?.map((r) => r.charsPerMin) ?? [1]));

  return (
    <div className="review">
      <header className="app-header">
        <div className="header-left">
          <h1>{lesson.title} — 振り返り</h1>
        </div>
        <div className="header-right">
          <Link className="btn" to="/dashboard">
            ダッシュボードへ
          </Link>
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
              {fmt(playhead)} / {fmt(durationMs)}
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
                {clips.map((c) => (
                  <button
                    key={c.id}
                    className="cluster-marker"
                    style={{
                      left: `${(c.centerMs / Math.max(durationMs, 1)) * 100}%`,
                      background: kindColor(Object.keys(c.kinds)[0] ?? 'comment'),
                    }}
                    title={`${fmt(c.centerMs)} — ${c.participantCount}人が反応`}
                    onClick={() => playClip(c)}
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
            <button className={`btn tab ${tab === 'clips' ? 'tab-active' : ''}`} onClick={() => setTab('clips')}>
              クリップ ({clips.length})
            </button>
            <button className={`btn tab ${tab === 'summary' ? 'tab-active' : ''}`} onClick={() => setTab('summary')}>
              AI要約
            </button>
            <button className={`btn tab ${tab === 'stats' ? 'tab-active' : ''}`} onClick={() => setTab('stats')}>
              統計
            </button>
          </div>

          {tab === 'clips' && (
            <div className="panel-scroll">
              {clips.length === 0 && <p className="muted">リアクションはありませんでした</p>}
              {clips.map((c) => (
                <div key={c.id} className="card clip-card">
                  <div className="clip-head">
                    <button className="btn primary" onClick={() => playClip(c)}>
                      ▶ {fmt(c.startMs)}〜{fmt(c.endMs)}
                    </button>
                    <strong>{c.participantCount}人が反応</strong>
                  </div>
                  <div className="clip-kinds">
                    {Object.entries(c.kinds).map(([k, n]) => (
                      <span key={k} className="kind-pill" style={{ background: kindColor(k) }}>
                        {kindLabel(k)} ×{n}
                      </span>
                    ))}
                  </div>
                  <p className="muted clip-names">
                    {c.participants.map((p) => p.name).filter((v, i, a) => a.indexOf(v) === i).join('、')}
                  </p>
                  {c.participants.filter((p) => p.comment).map((p, i) => (
                    <p key={i} className="clip-comment">
                      💬 {p.name}: {p.comment}
                    </p>
                  ))}
                  {c.transcriptText ? (
                    <details className="clip-transcript">
                      <summary>この区間の文字起こし{c.summaryText ? '・提案' : ''}</summary>
                      {c.summaryText && <p className="suggestion">{c.summaryText}</p>}
                      <p>{c.transcriptText}</p>
                    </details>
                  ) : (
                    <button className="btn" onClick={() => void transcribeClip(c)}>
                      この区間を文字起こし
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {tab === 'summary' && (
            <div className="panel-scroll">
              {!summary && (
                <div className="card">
                  <p className="muted">
                    録音全体を文字起こしして、反応が集中した箇所を中心にAIが要約します。
                  </p>
                  <button className="btn primary" onClick={() => void generateSummary()} disabled={generating}>
                    {generating ? '生成中...（数分かかることがあります）' : '文字起こしと要約を生成'}
                  </button>
                </div>
              )}
              {summary && (
                <>
                  <div className="card">
                    <h3>AI要約</h3>
                    <pre className="summary-text">{summary.summary}</pre>
                    <p className="muted">
                      生成: {new Date(summary.createdAt).toLocaleString('ja-JP')}（{summary.provider} / {summary.model}）
                    </p>
                    <button className="btn" onClick={() => void generateSummary()} disabled={generating}>
                      {generating ? '生成中...' : '再生成'}
                    </button>
                  </div>
                  <details className="card">
                    <summary>文字起こし全文</summary>
                    <pre className="summary-text">{summary.text}</pre>
                  </details>
                </>
              )}
            </div>
          )}

          {tab === 'stats' && stats && (
            <div className="panel-scroll">
              <div className="card">
                <h3>全体</h3>
                <p>
                  参加者 <strong>{stats.totalParticipants}</strong>人 ・ 反応{' '}
                  <strong>{stats.totalReactions}</strong>件
                </p>
                <div className="clip-kinds">
                  {Object.entries(stats.countsByKind).map(([k, n]) => (
                    <span key={k} className="kind-pill" style={{ background: kindColor(k) }}>
                      {kindLabel(k)} ×{n}
                    </span>
                  ))}
                </div>
              </div>

              <div className="card">
                <h3>反応の推移（1分ごと）</h3>
                <div className="bar-chart">
                  {stats.timeline.map((t) => (
                    <div
                      key={t.minute}
                      className="bar-col"
                      title={`${t.minute}分: ${t.total}件`}
                      onClick={() => seek(t.minute * 60_000, false)}
                    >
                      <div className="bar-stack">
                        {Object.entries(t.counts).map(([k, n]) => (
                          <div
                            key={k}
                            style={{
                              height: `${(n / maxTimelineTotal) * 100}%`,
                              background: kindColor(k),
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <p className="muted">クリックでその時刻へ移動</p>
              </div>

              <div className="card">
                <h3>話す速さ（文字/分）と反応の相関</h3>
                {stats.speechRate ? (
                  <div className="bar-chart rate">
                    {stats.speechRate.map((r) => (
                      <div key={r.minute} className="bar-col" title={`${r.minute}分: ${r.charsPerMin}字/分`}>
                        <div className="bar-stack">
                          <div style={{ height: `${(r.charsPerMin / maxRate) * 100}%`, background: '#60a5fa' }} />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="muted">「AI要約」タブで文字起こしを生成すると表示されます</p>
                )}
              </div>

              <div className="card">
                <h3>生徒別</h3>
                {stats.perParticipant.map((p) => (
                  <details key={p.participantId} className="student-row">
                    <summary>
                      <strong>{p.name}</strong> — {p.total}件{' '}
                      {Object.entries(p.counts)
                        .map(([k, n]) => `${kindLabel(k)}×${n}`)
                        .join(' / ')}
                    </summary>
                    {p.reactions.map((r, i) => (
                      <p key={i} className="muted student-reaction" onClick={() => seek(r.tMs, false)}>
                        {fmt(r.tMs)} {kindLabel(r.kind)}
                        {r.comment ? `「${r.comment}」` : ''}
                      </p>
                    ))}
                  </details>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <audio ref={audioRef} style={{ display: 'none' }} />
    </div>
  );
}
