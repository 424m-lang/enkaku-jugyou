import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { readStored, writeStored } from '../../lib/storage';

/** 前回この端末で参加したときの控え。タブを閉じても同じ生徒として戻れるようにする */
type LastJoin = { token: string; lessonId: string; displayName: string };

/**
 * 控えは **授業コードごと** に持つ。
 * 参加する前は授業IDが分からないので、生徒が入力したコードで引けるようにしてある。
 *
 * 自動では戻さず、ここで見せて選ばせるのは、学校が配る共有端末を想定しているため。
 * 黙って引き継ぐと、次に使う生徒が前の生徒として参加してしまう。
 */
const lastJoinKey = (code: string) => `lastJoin:${code.trim().toUpperCase()}`;

function readLastJoin(code: string): LastJoin | null {
  if (code.trim().length < 4) return null;
  const raw = readStored('local', lastJoinKey(code));
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object') return null;
    const { token, lessonId, displayName } = v as Partial<LastJoin>;
    if (typeof token !== 'string' || typeof lessonId !== 'string') return null;
    return { token, lessonId, displayName: typeof displayName === 'string' ? displayName : '' };
  } catch {
    return null;
  }
}

export default function Join() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [code, setCode] = useState(params.get('code') ?? '');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<LastJoin | null>(null);

  /**
   * コードを入れた時点で、この端末に前回の参加が残っていないか見る。
   *
   * 控えがあっても、それだけでは出さない。**その授業のものか**をサーバに確かめる。
   * 授業コードは4文字なので、将来べつの授業に同じコードが割り当たることがあり、
   * そのとき前の授業の名前を見せてしまうと生徒を混乱させる。
   */
  useEffect(() => {
    const saved = readLastJoin(code);
    if (!saved) {
      setLast(null);
      return;
    }
    let cancelled = false;
    // 入力の途中で毎回問い合わせないよう、少し待ってからにする
    const timer = setTimeout(() => {
      void api<{ canResume: boolean; displayName?: string }>('/api/join/resume-check', {
        method: 'POST',
        body: JSON.stringify({ code, resumeToken: saved.token }),
      })
        .then((r) => {
          if (cancelled) return;
          setLast(r.canResume ? { ...saved, displayName: r.displayName ?? saved.displayName } : null);
        })
        .catch(() => {
          // 確かめられないときは出さない（間違った名前を見せるより無いほうがよい）
          if (!cancelled) setLast(null);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code]);

  /**
   * resumeToken を渡すと、サーバがそれを検証して同じ生徒として戻す。
   * 授業が変わっていた・期限切れだった場合は、そのまま新しい生徒として参加する。
   * 生徒を袋小路に入れないため、ここでは失敗にしない。
   */
  async function join(resumeToken?: string) {
    setBusy(true);
    setError('');
    try {
      const res = await api<{
        participantToken: string;
        displayName: string;
        lesson: { id: string };
      }>('/api/join', {
        method: 'POST',
        body: JSON.stringify({ code, displayName, resumeToken }),
      });
      // 保存できない端末でもメモリに残るので、そのタブでは授業に入れる
      writeStored('session', 'participantToken', res.participantToken);
      writeStored('session', 'lessonId', res.lesson.id);
      writeStored('session', 'displayName', res.displayName);
      // タブを閉じても戻れるように、この端末にも控える
      writeStored(
        'local',
        lastJoinKey(code),
        JSON.stringify({
          token: res.participantToken,
          lessonId: res.lesson.id,
          displayName: res.displayName,
        } satisfies LastJoin)
      );
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
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void join();
          }}
          className="form"
        >
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

          {last && (
            <div className="join-resume">
              <p>
                この端末は先ほど <strong>{last.displayName || 'この授業'}</strong>{' '}
                として参加していました。
              </p>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void join(last.token)}
              >
                {busy ? '参加中...' : '続きから参加する'}
              </button>
            </div>
          )}

          <label>
            名前（入れなくても参加できます）
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={30}
              placeholder="空のままでも大丈夫です"
            />
          </label>
          <p className="muted small">
            空のままにすると「青いネコ」のような名前が自動で付きます。
            先生には反応やコメントがその名前で届きます。
          </p>
          {error && <p className="error">{error}</p>}
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? '参加中...' : last ? '新しく参加する' : '参加する'}
          </button>
        </form>
      </div>
    </div>
  );
}
