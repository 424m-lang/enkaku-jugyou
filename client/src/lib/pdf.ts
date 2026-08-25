import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { screenTokenFromUrl } from './screenToken';
import { readStored } from './storage';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const RENDER_WIDTH = 1600; // レンダリング解像度（表示はこれを縮小）

/**
 * PDFを参加時に一括ダウンロードし、全ページを事前レンダリングしてキャッシュする。
 * 授業中のスライド切替は追加の通信なしで行える（帯域の節約と即時表示）。
 */
export class PdfCache {
  private doc: pdfjs.PDFDocumentProxy;
  private bitmaps = new Map<number, Promise<ImageBitmap>>();

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
    return p;
  }

  private async renderInner(pageIndex: number): Promise<ImageBitmap> {
    const page = await this.doc.getPage(pageIndex + 1);
    const base = page.getViewport({ scale: 1 });
    const scale = RENDER_WIDTH / base.width;
    const viewport = page.getViewport({ scale });
    const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
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

  /** バックグラウンドで全ページを順に描画しておく（プリロード） */
  async preloadAll(): Promise<void> {
    for (let i = 0; i < this.doc.numPages; i++) {
      try {
        await this.render(i);
      } catch {
        /* 個別ページの失敗は無視 */
      }
    }
  }
}

async function loadPdfFrom(url: string, init?: RequestInit): Promise<PdfCache | null> {
  const res = await fetch(url, init);
  if (!res.ok) return null;
  const data = await res.arrayBuffer();
  const doc = await pdfjs.getDocument({ data }).promise;
  const cache = new PdfCache(doc);
  void cache.preloadAll();
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
