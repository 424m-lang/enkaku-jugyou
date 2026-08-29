import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { LessonTelemetry } from '@shared';
import { api, ApiError } from '../../lib/api';

type TelemetryLesson = {
  lessonId: string;
  title: string;
  status: 'draft' | 'live' | 'ended';
  createdAt: string;
  updatedAt: string | null;
  metrics: LessonTelemetry | null;
};

const STATUS_LABEL: Record<TelemetryLesson['status'], string> = {
  draft: '準備中',
  live: '授業中',
  ended: '終了',
};

function fmtBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

function fmtDelay(ms: number): string {
  return ms < 1_000 ? `${Math.round(ms)}ms` : `${(ms / 1_000).toFixed(1)}秒`;
}

function fmtDuration(ms: number): string {
  const seconds = Math.round(ms / 1_000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}分${String(seconds % 60).padStart(2, '0')}秒` : `${seconds}秒`;
}

function TelemetryDetail({ metrics }: { metrics: LessonTelemetry }) {
  const audioAverage =
    metrics.audio.startup.count > 0
      ? fmtDelay(metrics.audio.startup.totalMs / metrics.audio.startup.count)
      : '未計測';

  return (
    <>
      <div className="telemetry-grid">
        <section className="card telemetry-card">
          <h3>接続</h3>
          <p>最大同時接続　<strong>生徒 {metrics.maxConcurrentStudents}台</strong></p>
          <p>最大同時接続　<strong>教室モニター {metrics.maxConcurrentScreens}台</strong></p>
          <p className="muted small">
            接続画面：先生 {metrics.connectionSessions.teacher}／生徒{' '}
            {metrics.connectionSessions.student}／教室モニター {metrics.connectionSessions.screen}
          </p>
          <p className="muted small">
            再接続 {metrics.reconnects}回・切断 {metrics.disconnects}回（画面を閉じた場合を含む）
          </p>
        </section>

        <section className="card telemetry-card">
          <h3>端末の大分類</h3>
          <p>iPhone・iPadなど <strong>{metrics.platforms['apple-mobile']}画面</strong></p>
          <p>Android <strong>{metrics.platforms.android}画面</strong></p>
          <p>PC等 <strong>{metrics.platforms.desktop}画面</strong></p>
          <p className="muted small">
            Safari {metrics.browsers.safari}／Chrome・Edge系 {metrics.browsers.chromium}／
            Firefox {metrics.browsers.firefox}／その他 {metrics.browsers.other}
          </p>
        </section>

        <section className="card telemetry-card">
          <h3>音声</h3>
          <p>
            Opus受信 <strong>{metrics.audio.receiverSessions.webm}画面</strong>・AAC受信{' '}
            <strong>{metrics.audio.receiverSessions.mp4}画面</strong>
          </p>
          <p>
            受信開始まで <strong>平均 {audioAverage}</strong>
            {metrics.audio.startup.count > 0 && (
              <span className="muted small">
                {' '}（最大 {fmtDelay(metrics.audio.startup.maxMs)}・{metrics.audio.startup.count}画面）
              </span>
            )}
          </p>
          <p>
            途切れ <strong>{metrics.audio.stalls}回</strong>・回復{' '}
            <strong>{metrics.audio.recoveries}回</strong>・形式非対応{' '}
            <strong>{metrics.audio.unsupported}回</strong>
          </p>
          <p className="muted small">
            概算配信量 Opus {fmtBytes(metrics.audio.deliveredBytes.webm)}／AAC{' '}
            {fmtBytes(metrics.audio.deliveredBytes.mp4)}
          </p>
        </section>

        <section className="card telemetry-card">
          <h3>先生カメラ</h3>
          <p>
            WebM受信 <strong>{metrics.video.receiverSessions.webm}画面</strong>・MP4受信{' '}
            <strong>{metrics.video.receiverSessions.mp4}画面</strong>
          </p>
          <p>
            使用 <strong>{metrics.video.cameraStarts}回</strong>・合計{' '}
            <strong>{fmtDuration(metrics.video.activeMs)}</strong>
          </p>
          <p>
            生徒が閉じた回数 <strong>{metrics.video.closedByStudents}回</strong>・形式非対応{' '}
            <strong>{metrics.video.unsupported}回</strong>
          </p>
          <p className="muted small">
            概算配信量 WebM {fmtBytes(metrics.video.deliveredBytes.webm)}／MP4{' '}
            {fmtBytes(metrics.video.deliveredBytes.mp4)}
          </p>
        </section>
      </div>
      <p className="muted small telemetry-note">
        通信量はサーバから各受信画面へ送ったメディア断片の合計による概算です。
        Render全体のCPU・メモリ・転送量はRenderの管理画面で確認してください。
      </p>
    </>
  );
}

export default function Telemetry() {
  const navigate = useNavigate();
  const location = useLocation();
  const [lessons, setLessons] = useState<TelemetryLesson[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [error, setError] = useState('');

  useEffect(() => {
    void api<TelemetryLesson[]>('/api/telemetry')
      .then((rows) => {
        setLessons(rows);
        setSelectedId(rows.find((row) => row.metrics)?.lessonId ?? rows[0]?.lessonId ?? '');
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) navigate('/login');
        else setError('通信記録を読み込めませんでした');
      });
  }, [navigate]);

  const selected = useMemo(
    () => lessons.find((lesson) => lesson.lessonId === selectedId) ?? null,
    [lessons, selectedId]
  );
  const from = (location.state as { from?: unknown } | null)?.from;
  const backTo = typeof from === 'string' && from.startsWith('/') ? from : '/dashboard';

  return (
    <div className="telemetry-page">
      <header className="app-header">
        <div className="header-left">
          <h1>開発・検証用　匿名の通信記録</h1>
          <button className="btn header-action" onClick={() => navigate(backTo)}>
            元の画面に戻る
          </button>
        </div>
      </header>

      <main className="telemetry-main">
        <div className="card telemetry-privacy">
          <p>
            授業全体の傾向だけを記録しています。氏名、参加者ID、IPアドレス、発言内容、
            生の端末情報は保存しません。
          </p>
          <p className="muted small">
            この画面は通常の先生向け導線には表示されません。Ctrl（Macは⌘）+ Alt + T
            で開けます。
          </p>
        </div>

        {error && <p className="error">{error}</p>}
        {lessons.length === 0 && !error && <p className="muted">授業がありません。</p>}

        {lessons.length > 0 && (
          <label className="telemetry-lesson-select card">
            <span>確認する授業</span>
            <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
              {lessons.map((lesson) => (
                <option key={lesson.lessonId} value={lesson.lessonId}>
                  {new Date(lesson.createdAt).toLocaleDateString('ja-JP')}　{lesson.title}（
                  {STATUS_LABEL[lesson.status]}）
                </option>
              ))}
            </select>
          </label>
        )}

        {selected && (
          <section className="telemetry-result">
            <h2>{selected.title}</h2>
            {selected.metrics ? (
              <TelemetryDetail metrics={selected.metrics} />
            ) : (
              <div className="card">
                <h3>通信状況の記録はありません</h3>
                <p className="muted small">
                  この集計機能を追加する前に行った授業、またはまだ接続されていない授業です。
                </p>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
