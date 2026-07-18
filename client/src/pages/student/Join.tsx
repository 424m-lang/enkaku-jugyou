import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';

export default function Join() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [code, setCode] = useState(params.get('code') ?? '');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api<{ participantToken: string; lesson: { id: string } }>('/api/join', {
        method: 'POST',
        body: JSON.stringify({ code, displayName }),
      });
      sessionStorage.setItem('participantToken', res.participantToken);
      sessionStorage.setItem('lessonId', res.lesson.id);
      navigate('/class');
    } catch (err) {
      setError(err instanceof Error ? err.message : '参加に失敗しました');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-center">
      <div className="card auth-card">
        <h1>授業に参加</h1>
        <form onSubmit={onSubmit} className="form">
          <label>
            授業コード
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              required
              placeholder="例: B7KQ"
              maxLength={12}
              style={{ textTransform: 'uppercase', letterSpacing: '0.15em' }}
            />
          </label>
          <label>
            表示名（先生に見える名前）
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
              maxLength={30}
              placeholder="例: 山田 太郎"
            />
          </label>
          {error && <p className="error">{error}</p>}
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? '参加中...' : '参加する'}
          </button>
        </form>
      </div>
    </div>
  );
}
