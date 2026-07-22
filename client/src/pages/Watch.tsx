import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { PointerPayload, StrokePayload, WatchPage } from '@shared';
import { loadWatchPdf, type PdfCache } from '../lib/pdf';
import { applyDrawingEvent, type StrokesBySlide } from '../lib/strokes';
import { fmtClock } from '../lib/format';
import SlideCanvas from '../components/SlideCanvas';

/**
 * 生徒向けの復習ページ（ログイン不要）。
 * 章を順につないで再生することで、動画ファイルを作らずに復習動画として機能する。
 * 誰がどう反応したかの情報は一切表示しない。
 */
export default function Watch() {
  const { token } = useParams<{ token: string }>();

  const [page, setPage] = useState<WatchPage | null>(null);
  const [pdf, setPdf] = useState<PdfCache | null>(null);
  const [error, setError] = useState('');
  const [chapterIdx, setChapterIdx] = useState(0);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);

  const audioRef = useRef<HTMLAudioElement>(null);
  const currentFileRef = useRef<string | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  // 章の終わりで次の章へ自動で送るための参照（再生中に更新されるので ref で持つ）
  const chapterIdxRef = useRef(0);
  chapterIdxRef.current = chapterIdx;

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const res = await fetch(`/api/watch/${encodeURIComponent(token)}`);
        if (!res.ok) {
          setError('この復習ページは公開されていません');
          return;
        }
        const data = (await res.json()) as WatchPage;
        setPage(data);
        setPlayhead(data.chapters[0]?.startMs ?? 0);
        setPdf(await loadWatchPdf(token));
      } catch {
        setError('読み込みに失敗しました');
      }
    })();
  }, [token]);

  const chapters = page?.chapters ?? [];
  const chapter = chapters[chapterIdx] ?? null;

  // ---- 再生位置から表示状態（スライド・書き込み・ポインター）を再構成 ----
  const view = useMemo(() => {
    let slideId: string | null = null;
    const strokesBy: StrokesBySlide = {};
    let pointer: PointerPayload | null = null;
    let lastPointerT = -Infinity;
    for (const ev of page?.events ?? []) {
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
  }, [page, playhead]);

  const currentSlide = page?.slides.find((s) => s.id === view.slideId) ?? null;

  const partFor = useCallback(
    (tMs: number) => {
      let found: { file: string; startMs: number } | null = null;
      for (const p of page?.audioParts ?? []) {
        if (p.startMs <= tMs) found = p;
      }
      return found ?? page?.audioParts[0] ?? null;
    },
    [page]
  );

  const seek = useCallback(
    (tMs: number, autoplay = true) => {
      setPlayhead(tMs);
      const audio = audioRef.current;
      const part = partFor(tMs);
      if (!audio || !part || !token) return;
      const offsetSec = Math.max(0, (tMs - part.startMs) / 1000);
      if (currentFileRef.current !== part.file) {
        currentFileRef.current = part.file;
        pendingSeekRef.current = offsetSec;
        audio.src = `/api/watch/${encodeURIComponent(token)}/audio/${part.file}`;
        audio.load();
        if (autoplay) void audio.play().catch(() => {});
      } else {
        audio.currentTime = offsetSec;
        if (autoplay) void audio.play().catch(() => {});
      }
    },
    [partFor, token]
  );

  const goToChapter = useCallback(
    (idx: number, autoplay = true) => {
      const c = chapters[idx];
      if (!c) return;
      setChapterIdx(idx);
      seek(c.startMs, autoplay);
    },
    [chapters, seek]
  );

  // 章の終わりに達したら次の章へ送る（つまずいた箇所だけを続けて見られる）
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !page) return;
    const onMeta = () => {
      if (pendingSeekRef.current !== null) {
        audio.currentTime = pendingSeekRef.current;
        pendingSeekRef.current = null;
      }
    };
    const onTime = () => {
      const part =
        page.audioParts.find((p) => p.file === currentFileRef.current) ?? page.audioParts[0];
      if (!part) return;
      const t = part.startMs + audio.currentTime * 1000;
      setPlayhead(t);
      const cur = page.chapters[chapterIdxRef.current];
      if (cur && t >= cur.endMs) {
        const next = chapterIdxRef.current + 1;
        if (next < page.chapters.length) {
          setChapterIdx(next);
          seek(page.chapters[next].startMs);
        } else {
          audio.pause();
        }
      }
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    return () => {
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
    };
  }, [page, seek]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) audio.pause();
    else if (!currentFileRef.current) goToChapter(chapterIdx);
    else void audio.play().catch(() => {});
  }, [playing, chapterIdx, goToChapter]);

  if (error) {
    return (
      <div className="page-center">
        <p className="error">{error}</p>
      </div>
    );
  }
  if (!page) {
    return (
      <div className="page-center">
        <p>読み込み中...</p>
      </div>
    );
  }

  // 章内での進み具合（章をまたぐ通しのシークバーではなく、章単位で分かりやすく）
  const chapterProgress = chapter
    ? Math.min(1, Math.max(0, (playhead - chapter.startMs) / Math.max(1, chapter.endMs - chapter.startMs)))
    : 0;

  return (
    <div className="watch">
      <header className="app-header">
        <div className="header-left">
          <h1>{page.title} — 復習</h1>
        </div>
      </header>

      <div className="watch-main">
        <div className="watch-player">
          <SlideCanvas
            pdf={pdf}
            slide={currentSlide}
            strokes={view.slideId ? (view.strokesBy[view.slideId] ?? []) : []}
            pointer={view.pointer && view.pointer.slideId === view.slideId ? view.pointer : null}
          />

          <div className="player">
            <button
              className="btn primary"
              onClick={togglePlay}
              disabled={page.audioParts.length === 0}
            >
              {playing ? '⏸ 一時停止' : '▶ 再生'}
            </button>
            <span className="player-time">
              {chapter ? `${chapterIdx + 1}章 / 全${chapters.length}章` : ''}
            </span>
            <div className="scrubber">
              <input
                type="range"
                min={chapter?.startMs ?? 0}
                max={chapter?.endMs ?? 1}
                value={Math.min(Math.max(playhead, chapter?.startMs ?? 0), chapter?.endMs ?? 1)}
                onChange={(e) => seek(Number(e.target.value), playing)}
              />
              <div className="watch-progress" style={{ width: `${chapterProgress * 100}%` }} />
            </div>
            <button
              className="btn"
              onClick={() => goToChapter(chapterIdx - 1)}
              disabled={chapterIdx <= 0}
            >
              ← 前の章
            </button>
            <button
              className="btn"
              onClick={() => goToChapter(chapterIdx + 1)}
              disabled={chapterIdx >= chapters.length - 1}
            >
              次の章 →
            </button>
          </div>
          {page.audioParts.length === 0 && (
            <p className="muted" style={{ textAlign: 'center' }}>
              録音がありません（スライドと書き込みの再現のみ見られます）
            </p>
          )}
        </div>

        <aside className="watch-chapters">
          <h3>目次</h3>
          {chapters.length === 0 && <p className="muted">章がありません</p>}
          {chapters.map((c, i) => (
            <button
              key={c.id}
              className={`watch-chapter ${i === chapterIdx ? 'watch-chapter-active' : ''}`}
              onClick={() => goToChapter(i)}
            >
              <span className="watch-chapter-head">
                <strong>{i + 1}. {c.title}</strong>
                <span className="muted small">
                  {fmtClock(c.startMs)}〜{fmtClock(c.endMs)}
                </span>
              </span>
              {c.description && <span className="watch-chapter-desc">{c.description}</span>}
            </button>
          ))}
        </aside>
      </div>

      <audio ref={audioRef} style={{ display: 'none' }} />
    </div>
  );
}
