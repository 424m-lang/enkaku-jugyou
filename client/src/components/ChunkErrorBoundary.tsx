import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * 画面ごとのコードを後から読み込む仕組み（コード分割）の、取りこぼしを受け止める。
 *
 * **何が起きるか**
 * 各画面は `import()` で必要になってから読み込んでいる。読み込むファイル名には
 * 中身から作ったハッシュが入るので、サーバを新しい版に入れ替えるとファイル名が変わる。
 * 入れ替えの前からタブを開いたままの人は、**古いファイル名を指した index.html** を
 * 持っているので、そこから別の画面へ進もうとした瞬間に読み込みが失敗する。
 *
 * 授業前にダッシュボードを開いておき、こちらがデプロイし、先生が授業を開く——
 * という順番で普通に起こる。
 *
 * **受け止めないとどうなるか**
 * `import()` の失敗は React の描画中の例外になり、受け止め手がないと木ごと落ちる。
 * つまり**その画面だけでなく、アプリ全体が真っ白**になる。授業中だと復帰の手立てが無い。
 *
 * **どうするか**
 * 読み込みの失敗のときだけ、一度だけ自動で読み直す。新しい index.html を取り直せば
 * 新しいファイル名で読めるので、多くの場合そのまま復帰する。
 * 読み直しても駄目なとき（本当に壊れている・回線が切れている）は、
 * 真っ白ではなく操作できる案内を出す。
 */

/** 読み込みそのものの失敗か（ブラウザごとに文言が違うので、代表的なものを見る） */
function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return (
    /dynamically imported module/i.test(message) || // Chrome / Edge
    /error loading dynamically imported module/i.test(message) || // Firefox
    /Importing a module script failed/i.test(message) || // Safari
    /Loading chunk .* failed/i.test(message) ||
    /MIME type of "?text\/html/i.test(message) // 消えたファイルにHTMLが返ったとき
  );
}

/** 読み直しは1回だけにする（無限に読み直し続けないため）。タブを閉じれば消える */
const RELOADED_KEY = 'chunkReloadedAt';
const RELOAD_WINDOW_MS = 60_000;

function alreadyReloaded(): boolean {
  try {
    const at = Number(sessionStorage.getItem(RELOADED_KEY) ?? '0');
    return Number.isFinite(at) && Date.now() - at < RELOAD_WINDOW_MS;
  } catch {
    return false; // sessionStorage が使えない端末では、案内を出す側に倒す
  }
}

function markReloaded(): void {
  try {
    sessionStorage.setItem(RELOADED_KEY, String(Date.now()));
  } catch {
    /* 使えなくても読み直しは試す */
  }
}

type Props = { children: ReactNode };
type State = { failed: boolean };

export class ChunkErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (isChunkLoadError(error) && !alreadyReloaded()) {
      // 新しい index.html を取り直せば、新しいファイル名で読み込める
      markReloaded();
      console.warn('[chunk] 画面の読み込みに失敗したため、一度だけ読み直します:', error.message);
      window.location.reload();
      return;
    }
    console.error('[app] 画面の描画に失敗しました:', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="page-center">
        <div className="card">
          <h1>画面を読み込めませんでした</h1>
          <p>
            通信が途切れているか、サーバが新しい版に入れ替わった直後の可能性があります。
            読み込み直すと直ることがあります。
          </p>
          <button
            className="btn primary"
            onClick={() => {
              try {
                sessionStorage.removeItem(RELOADED_KEY);
              } catch {
                /* 消せなくても読み直す */
              }
              window.location.reload();
            }}
          >
            読み込み直す
          </button>
        </div>
      </div>
    );
  }
}
