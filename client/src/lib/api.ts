export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
  if (typeof opts.body === 'string') headers['Content-Type'] = 'application/json';
  const token = sessionStorage.getItem('participantToken');
  if (token) headers['x-participant-token'] = token;

  const res = await fetch(path, { credentials: 'same-origin', ...opts, headers });
  if (!res.ok) {
    let msg = `エラーが発生しました (${res.status})`;
    try {
      const d = await res.json();
      if (d?.error) msg = d.error;
    } catch {
      /* JSONでないレスポンスはそのまま */
    }
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

export type Teacher = { id: string; loginId: string; name: string };
