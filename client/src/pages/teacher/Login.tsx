import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';

export default function Login() {
  const navigate = useNavigate();
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ loginId, password }),
      });
      navigate('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ログインに失敗しました');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-center">
      <div className="card auth-card">
        <h1>先生ログイン</h1>
        <form onSubmit={onSubmit} className="form">
          <label>
            ログインID
            <input
              value={loginId}
              onChange={(e) => setLoginId(e.target.value)}
              required
              autoComplete="username"
              placeholder="例: tanaka-suugaku"
            />
          </label>
          <label>
            パスワード
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </label>
          {error && <p className="error">{error}</p>}
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'ログイン中...' : 'ログイン'}
          </button>
        </form>
        <p className="muted">
          アカウントがない場合は <Link to="/register">新規登録</Link>
        </p>
        <p className="muted">
          生徒の方は <Link to="/join">授業に参加</Link>
        </p>
      </div>
    </div>
  );
}
