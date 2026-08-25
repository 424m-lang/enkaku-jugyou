/**
 * localStorage / sessionStorage の読み書き。
 *
 * **読むだけで例外を投げる環境がある**（サイトのストレージを禁止している設定、
 * 一部のアプリ内ブラウザ、古いプライベートブラウズ）。素で呼ぶと描画の途中で
 * 投げて画面が丸ごと出なくなるため、必ずここを通す。
 *
 * 加えて、保存できなかったときはメモリに置いて動き続ける。
 * 参加トークンが保存できないと授業に入れなくなるが、メモリに持っていれば
 * そのタブを開いている間は成立する（読み込み直すと消えるが、入れないよりよい）。
 */

const memory = new Map<string, string>();

function pick(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readStored(kind: 'local' | 'session', key: string): string | null {
  try {
    const v = pick(kind)?.getItem(key);
    if (v !== null && v !== undefined) return v;
  } catch {
    /* 使えない環境。メモリへ落とす */
  }
  return memory.get(`${kind}:${key}`) ?? null;
}

export function writeStored(kind: 'local' | 'session', key: string, value: string): void {
  memory.set(`${kind}:${key}`, value);
  try {
    pick(kind)?.setItem(key, value);
  } catch {
    /* 保存できなくても、このタブを開いている間はメモリで足りる */
  }
}
