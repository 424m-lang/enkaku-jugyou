import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

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

export async function loadLessonPdf(lessonId: string): Promise<PdfCache | null> {
  const token = sessionStorage.getItem('participantToken');
  const res = await fetch(`/api/lessons/${lessonId}/pdf`, {
    credentials: 'same-origin',
    headers: token ? { 'x-participant-token': token } : {},
  });
  if (!res.ok) return null;
  const data = await res.arrayBuffer();
  const doc = await pdfjs.getDocument({ data }).promise;
  const cache = new PdfCache(doc);
  void cache.preloadAll();
  return cache;
}
