import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { DEFAULT_REACTION_BUTTONS, type LessonSummary } from '@shared';
import { api, ApiError, type Teacher } from '../../lib/api';

const STATUS_LABEL: Record<string, string> = {
  draft: '準備中',
  live: '授業中',
  ended: '終了',
};

export default function Dashboard() {
  const navigate = useNavigate();
  const [teacher, setTeacher] = useState<Teacher | null>(null);
  const [lessons, setLessons] = useState<LessonSummary[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        setTeacher(await api<Teacher>('/api/auth/me'));
        setLessons(await api<LessonSummary[]>('/api/lessons'));
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) navigate('/login');
        else setError('読み込みに失敗しました');
      }
    })();
  }, [navigate]);

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' });
    navigate('/login');
  }

  return (
    <div className="dashboard">
      <header className="app-header">
        <h1>遠隔授業フィードバック</h1>
        <div className="header-right">
          {teacher && <span className="muted">{teacher.name} 先生</span>}
          <button className="btn" onClick={logout}>
            ログアウト
          </button>
        </div>
      </header>

      <main className="dashboard-main">
        <div className="dashboard-toolbar">
          <h2>授業一覧</h2>
          <button className="btn primary" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? '閉じる' : '＋ 新しい授業を作成'}
          </button>
        </div>

        {error && <p className="error">{error}</p>}

        {showCreate && (
          <CreateLessonForm
            onCreated={(l) => {
              setLessons((prev) => [l, ...prev]);
              setShowCreate(false);
            }}
          />
        )}

        <div className="lesson-grid">
          {lessons.map((l) => (
            <div key={l.id} className="card lesson-card">
              <div className="lesson-card-head">
                <strong>{l.title}</strong>
                <span className={`chip chip-${l.status}`}>{STATUS_LABEL[l.status]}</span>
              </div>
              <div className="join-code" title="生徒に伝える授業コード">
                {l.joinCode}
              </div>
              <p className="muted">
                スライド {l.pdfPageCount ?? '-'} ページ ・{' '}
                {new Date(l.createdAt).toLocaleDateString('ja-JP')}
              </p>
              <div className="lesson-card-actions">
                {l.status !== 'ended' && (
                  <Link className="btn primary" to={`/teach/${l.id}`}>
                    {l.status === 'live' ? '授業画面に戻る' : '授業画面へ'}
                  </Link>
                )}
                {l.status === 'ended' && (
                  <Link className="btn" to={`/review/${l.id}`}>
                    振り返り・統計
                  </Link>
                )}
              </div>
            </div>
          ))}
          {lessons.length === 0 && !showCreate && (
            <p className="muted">まだ授業がありません。「新しい授業を作成」から始めてください。</p>
          )}
        </div>
      </main>
    </div>
  );
}

/**
 * 新しい授業の作成。
 *
 * 聞くのはタイトルとスライドだけにしてある。リアクションボタンは授業画面の
 * 「リアクションボタン」から、授業中でも足したり隠したりできるので、
 * 作るときに決めさせる意味がない（作成前に何を聞きたいかは決まっていない）。
 */
function CreateLessonForm({ onCreated }: { onCreated: (l: LessonSummary) => void }) {
  const [title, setTitle] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function moveFile(i: number, delta: number) {
    setFiles((prev) => {
      const j = i + delta;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (files.length === 0) {
      setError('スライドPDFを選択してください');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('title', title);
      // ボタンの中身は既定のまま作り、授業画面で必要に応じて編集する
      fd.append('reactionButtons', JSON.stringify(DEFAULT_REACTION_BUTTONS));
      fd.append('reactionsEnabled', 'true');
      for (const f of files) fd.append('pdf', f, f.name);
      const res = await fetch('/api/lessons', { method: 'POST', body: fd });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? '作成に失敗しました');
      }
      onCreated((await res.json()) as LessonSummary);
    } catch (err) {
      setError(err instanceof Error ? err.message : '作成に失敗しました');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card create-form" onSubmit={onSubmit}>
      <h3>新しい授業</h3>
      <div className="form">
        <label>
          授業タイトル
          <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={100} />
        </label>
        <div className="pdf-picker">
          <span>スライドPDF（複数選べます。上から順につながって1つのスライドになります）</span>
          {/* ブラウザ標準の入力欄は、選んだ後も「選択されていません」と出したままになる。
              選んだPDFは下の一覧で見せるので、入力欄自体は隠してボタンだけ置く */}
          <input
            id="pdf-input"
            className="visually-hidden"
            type="file"
            accept="application/pdf"
            multiple
            onChange={(e) => {
              const added = Array.from(e.target.files ?? []);
              if (added.length > 0) setFiles((prev) => [...prev, ...added]);
              e.target.value = ''; // 同じファイルを選び直せるようにリセット
            }}
          />
          <label className="btn" htmlFor="pdf-input">
            {files.length === 0 ? 'PDFを選ぶ' : 'PDFを追加する'}
          </label>
          {files.length === 0 && <span className="muted small">まだ選ばれていません</span>}
        </div>
        {files.length > 0 && (
          <div className="pdf-file-list">
            {files.map((f, i) => (
              <div key={`${f.name}-${i}`} className="pdf-file-row">
                <span className="pdf-file-order">{i + 1}</span>
                <span className="pdf-file-name">{f.name}</span>
                <button type="button" className="btn" disabled={i === 0} onClick={() => moveFile(i, -1)}>
                  ↑
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={i === files.length - 1}
                  onClick={() => moveFile(i, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                >
                  削除
                </button>
              </div>
            ))}
          </div>
        )}
        <p className="muted small">
          リアクションボタン・タスク・アンケートは、授業画面から授業中でも設定できます。
        </p>
        {error && <p className="error">{error}</p>}
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? '作成中...' : '授業を作成'}
        </button>
      </div>
    </form>
  );
}
