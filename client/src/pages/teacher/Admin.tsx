import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';

type AdminLesson = {
  id: string;
  title: string;
  status: 'draft' | 'live' | 'ended';
  createdAt: string;
  startedAt: string | null;
  teacherId: string;
  teacherName: string;
  teacherLoginId: string;
  hasTelemetry: boolean;
};

type TeacherGroup = {
  teacherId: string;
  teacherName: string;
  teacherLoginId: string;
  lessons: AdminLesson[];
};

const STATUS_LABEL: Record<AdminLesson['status'], string> = {
  draft: '準備中',
  live: '授業中',
  ended: '終了',
};

/**
 * 管理者向けの授業一覧。すべての先生の授業から、振り返り画面と通信記録を開く。
 * どちらの画面も閲覧専用で、ここから授業を変更する操作は置かない
 */
export default function Admin() {
  const navigate = useNavigate();
  const [lessons, setLessons] = useState<AdminLesson[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [teacherFilter, setTeacherFilter] = useState('all');
  const [error, setError] = useState('');

  useEffect(() => {
    void api<AdminLesson[]>('/api/admin/lessons')
      .then((rows) => {
        setLessons(rows);
        setLoaded(true);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) navigate('/login');
        else if (err instanceof ApiError && err.status === 403) {
          setError('この画面は管理者に指定された先生だけが開けます。');
        } else setError('授業の一覧を読み込めませんでした');
      });
  }, [navigate]);

  // 先生ごとにまとめる。並びは各先生の最新の授業が新しい順（APIが新しい順で返すため）
  const groups = useMemo(() => {
    const byTeacher = new Map<string, TeacherGroup>();
    for (const l of lessons) {
      const g = byTeacher.get(l.teacherId) ?? {
        teacherId: l.teacherId,
        teacherName: l.teacherName,
        teacherLoginId: l.teacherLoginId,
        lessons: [],
      };
      g.lessons.push(l);
      byTeacher.set(l.teacherId, g);
    }
    return [...byTeacher.values()];
  }, [lessons]);

  const visibleGroups =
    teacherFilter === 'all' ? groups : groups.filter((g) => g.teacherId === teacherFilter);

  return (
    <div className="dashboard">
      <header className="app-header">
        <div className="header-left">
          <h1>すべての先生の授業</h1>
          <button className="btn header-action" onClick={() => navigate('/dashboard')}>
            授業一覧へ
          </button>
        </div>
      </header>

      <main className="dashboard-main admin-main">
        {/* 管理者でない先生が開いたときは、断りの文だけを出す */}
        {loaded && (
          <div className="card telemetry-privacy">
            <p>
              管理者として閲覧しています。振り返り画面と通信記録は閲覧だけができ、
              授業の変更・AIの実行・復習動画の公開はできません。
            </p>
            <p className="muted small">
              振り返り画面では、名前を入力して参加した生徒の名前を伏せて表示します。
              仮名で参加した生徒は仮名のまま表示します。コメント・アンケートの回答の本文と、授業の録音はそのまま含まれます。
            </p>
          </div>
        )}

        {error && <p className="error">{error}</p>}
        {loaded && lessons.length === 0 && <p className="muted">授業がありません。</p>}

        {groups.length > 1 && (
          <label className="card telemetry-lesson-select">
            <span>先生</span>
            <select value={teacherFilter} onChange={(e) => setTeacherFilter(e.target.value)}>
              <option value="all">すべての先生（{lessons.length}件）</option>
              {groups.map((g) => (
                <option key={g.teacherId} value={g.teacherId}>
                  {g.teacherName}（{g.teacherLoginId}）{g.lessons.length}件
                </option>
              ))}
            </select>
          </label>
        )}

        {visibleGroups.map((g) => (
          <section key={g.teacherId} className="admin-teacher">
            <h2>
              {g.teacherName} 先生
              <span className="muted small">
                {' '}
                {g.teacherLoginId} ・ {g.lessons.length}件
              </span>
            </h2>
            <div className="admin-lesson-list">
              {g.lessons.map((l) => (
                <div key={l.id} className="card admin-lesson-row">
                  <span className="admin-lesson-date muted small">
                    {new Date(l.startedAt ?? l.createdAt).toLocaleDateString('ja-JP')}
                  </span>
                  <strong className="admin-lesson-title">{l.title}</strong>
                  <span className={`chip chip-${l.status}`}>{STATUS_LABEL[l.status]}</span>
                  <div className="admin-lesson-actions">
                    {/* 振り返りは終わった授業だけ（先生の授業一覧と同じ条件） */}
                    {l.status === 'ended' && (
                      <Link className="btn" to={`/review/${l.id}`}>
                        振り返り
                      </Link>
                    )}
                    {l.hasTelemetry && (
                      <Link
                        className="btn"
                        to={`/telemetry?lesson=${encodeURIComponent(l.id)}`}
                        state={{ from: '/admin' }}
                      >
                        通信記録
                      </Link>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </main>
    </div>
  );
}
