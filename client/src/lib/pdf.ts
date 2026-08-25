import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { screenTokenFromUrl } from './screenToken';
import { readStored } from './storage';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * レンダリング解像度。表示はこれを縮小して使う。
 *
 * 端末の画面に合わせて落とす。1ページぶんの `ImageBitmap` は
 * 幅×高さ×4バイトを**非圧縮で**持つので、1600幅の16:9で約5.8MB。
 * スマートフォンにそこまでの解像度は要らないうえ、**iOSはキャンバスに
 * 使えるメモリの総量に上限があり、超えるとエラーも出さずに真っ白に描かれる**。
 */
const RENDER_WIDTH = Math.min(
  1600,
  Math.max(1000, Math.round(window.screen.width * (window.devicePixelRatio || 1)))
);

/**
 * 同時に持っておくページ数。
 *
 * 以前は全ページを事前に描いて持ち続けていた。そのため
 * - 40ページの資料なら非圧縮で200MBを超え、iOSの上限に当たって白紙になる
 * - 参加直後に全ページを描くので、その間スマートフォンでは映像がカクつく
 * が同時に起きていた。前後だけ持てば、順に進む授業では待ちは出ない
 */
const MAX_CACHED_PAGES = 6;

/**
 * PDFを参加時に一括ダウンロードし、表示するページの前後だけを描いて持つ。
 * 授業中のスライド切替は追加の通信なしで行える（帯域の節約と即時表示）。
 */
export class PdfCache {
  private doc: pdfjs.PDFDocumentProxy;
  private bitmaps = new Map<number, Promise<ImageBitmap>>();
  /** 使った順（古いものが先頭）。あふれたら古い方から手放す */
  private order: number[] = [];

  constructor(doc: pdfjs.PDFDocumentProxy) {
    this.doc = doc;
  }

  get pageCount(): number {
    return this.doc.numPages;
  }

  render(pageIndex: number): Promise<ImageBitmap> {
    let p = this.bitmaps.get(pageIndex);
    if (!p) {
      p = this.renderInner(pageIndex);
      this.bitmaps.set(pageIndex, p);
    }
    this.touch(pageIndex);
    return p;
  }

  private touch(pageIndex: number): void {
    this.order = this.order.filter((i) => i !== pageIndex);
    this.order.push(pageIndex);
    // close() はしない。表示中の画面がまだ参照していると描画で例外になるため、
    // 参照を手放してGCに任せる（持ち続ける枚数を絞ることが目的）
    while (this.order.length > MAX_CACHED_PAGES) {
      const drop = this.order.shift();
      if (drop !== undefined) this.bitmaps.delete(drop);
    }
  }

  /**
   * 表示中のページの前後を、裏で描いておく。
   * 全ページではなく前後だけにするのは、MAX_CACHED_PAGES と同じ理由
   */
  prefetchAround(pageIndex: number): void {
    for (const i of [pageIndex + 1, pageIndex + 2, pageIndex - 1]) {
      if (i < 0 || i >= this.doc.numPages) continue;
      if (this.bitmaps.has(i)) continue;
      void this.render(i).catch(() => {
        /* 先読みの失敗は表示に影響しない */
      });
    }
  }

  private async renderInner(pageIndex: number): Promise<ImageBitmap> {
    const page = await this.doc.getPage(pageIndex + 1);
    const base = page.getViewport({ scale: 1 });
    const scale = RENDER_WIDTH / base.width;
    const viewport = page.getViewport({ scale });
    const w = Math.ceil(viewport.width);
    const h = Math.ceil(viewport.height);

    // OffscreenCanvas はSafari 16.4以降にしか無い。無い端末では例外になり、
    // 「PDFが1ページも描けない＝ずっと白紙」になるので通常のcanvasに落とす
    if (typeof OffscreenCanvas === 'undefined') {
      const el = document.createElement('canvas');
      el.width = w;
      el.height = h;
      const ctx2d = el.getContext('2d');
      if (!ctx2d) throw new Error('この端末ではスライドを描画できません');
      await page.render({ canvasContext: ctx2d, viewport }).promise;
      return await createImageBitmap(el);
    }

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d')!;
    await page.render({
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;
    return canvas.transferToImageBitmap();
  }

  /**
   * 全ページの本文テキスト。復習動画のブロック分けで、先生の発言と一緒に
   * スライドの内容もAIに参考にさせるために使う（サーバへ送って保存する）。
   */
  async allPageTexts(): Promise<string[]> {
    const out: string[] = [];
    for (let i = 0; i < this.doc.numPages; i++) {
      try {
        const page = await this.doc.getPage(i + 1);
        const content = await page.getTextContent();
        out.push(
          content.items
            .map((it) => ('str' in it ? it.str : ''))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim()
        );
      } catch {
        out.push(''); // 画像だけのページなど
      }
    }
    return out;
  }

  /** 最初に見えるページだけ先に描いておく（全ページは描かない） */
  async preloadFirst(): Promise<void> {
    try {
      await this.render(0);
      this.prefetchAround(0);
    } catch {
      /* 失敗しても、表示するときに作り直す */
    }
  }
}

async function loadPdfFrom(url: string, init?: RequestInit): Promise<PdfCache | null> {
  const res = await fetch(url, init);
  if (!res.ok) return null;
  const data = await res.arrayBuffer();
  const doc = await pdfjs.getDocument({ data }).promise;
  const cache = new PdfCache(doc);
  void cache.preloadFirst();
  return cache;
}

export async function loadLessonPdf(lessonId: string): Promise<PdfCache | null> {
  const token = readStored('session', 'participantToken');
  const screenToken = screenTokenFromUrl();
  return loadPdfFrom(`/api/lessons/${lessonId}/pdf`, {
    credentials: 'same-origin',
    headers: {
      ...(token ? { 'x-participant-token': token } : {}),
      ...(screenToken ? { 'x-screen-token': screenToken } : {}),
    },
  });
}

/**
 * PDF各ページの本文を抽出してサーバへ保存する（先生の画面からのみ呼ぶ）。
 * サーバ側では、文字起こしに渡す用語のヒントと、復習動画のブロック分けに使う。
 * 何度呼んでも同じ結果を上書きするだけなので、失敗しても無視してよい。
 */
export async function savePdfTexts(lessonId: string, cache: PdfCache): Promise<void> {
  const texts = await cache.allPageTexts();
  if (texts.every((t) => !t)) return; // 画像だけのPDFは送らない
  await fetch(`/api/lessons/${lessonId}/pdf-text`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts }),
  });
}

/** 復習ページ（ログイン不要・公開トークン）のPDF */
export async function loadWatchPdf(token: string): Promise<PdfCache | null> {
  return loadPdfFrom(`/api/watch/${encodeURIComponent(token)}/pdf`);
}
