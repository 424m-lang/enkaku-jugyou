import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';

export default function Register() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ name, loginId, password }),
      });
      navigate('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : '登録に失敗しました');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-center">
      <div className="card auth-card">
        <h1>先生アカウント登録</h1>
        <p className="muted">
          メールアドレス等の個人情報は不要です。ログインIDと表示名は自由に決められます。
        </p>
        <form onSubmit={onSubmit} className="form">
          <label>
            表示名（ニックネーム可）
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={50}
              placeholder="例: 田中先生"
            />
          </label>
          <label>
            ログインID（半角英数字 3〜30文字）
            <input
              value={loginId}
              onChange={(e) => setLoginId(e.target.value)}
              required
              minLength={3}
              maxLength={30}
              pattern="[a-zA-Z0-9_\-]+"
              autoComplete="username"
              placeholder="例: tanaka-suugaku"
            />
          </label>
          <label>
            パスワード（8文字以上）
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
            />
          </label>
          <p className="muted">
            ※ パスワードを忘れた場合の再設定はできません。忘れないよう控えてください。
          </p>
          {error && <p className="error">{error}</p>}
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? '登録中...' : '登録する'}
          </button>
        </form>
        <p className="muted">
          既にアカウントがある場合は <Link to="/login">ログイン</Link>
        </p>
      </div>
    </div>
  );
}
