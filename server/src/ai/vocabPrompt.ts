import { eq } from 'drizzle-orm';
import { db, schema } from '../db';

/**
 * 文字起こしに渡す「用語のヒント」を、授業タイトルとスライドPDFの本文から作る。
 *
 * Whisperは prompt に書かれた語を優先して当てにいくので、授業の専門用語や固有名詞
 * （「フーリエ変換」「高知工科大学」など）を渡しておくと、そこの認識が崩れにくくなる。
 * promptは長すぎると無視されたり悪影響が出るため、短く保つ。
 */

/** promptに詰め込む上限（Whisperのprompt上限に対して十分に短く保つ） */
const MAX_PROMPT_CHARS = 200;
/** 拾う用語の最大数 */
const MAX_TERMS = 40;

// スライドに頻出するが認識のヒントにならない一般語（枠を専門用語に譲る）
const STOP_WORDS = new Set([
  '説明', '問題', '解説', '確認', '以下', '以上', '場合', '内容', '今回', '前回',
  '次回', '本日', '授業', '講義', '演習', '課題', '目次', '参考', '文献', '注意',
  '重要', '例題', '練習', '一つ', '二つ', '方法', '結果', '理由', '関係', '状態',
]);

/**
 * 日本語のスライド本文から用語らしい語を頻度順に抜き出す。
 * 形態素解析は使わず、漢字・カタカナ・英数字が続く範囲を1語の候補として扱う。
 * ひらがな（「の」「と」など）で切れるので、「フーリエ変換」のような
 * カタカナ＋漢字の複合語もひとまとまりで拾える。
 * スライド全体で繰り返し出てくる語ほどその授業の主題なので、頻度順で十分に効く。
 */
export function extractTerms(text: string): string[] {
  const pattern = /[一-龥々ァ-ヶーA-Za-z0-9]{2,}/g;
  const counts = new Map<string, number>();
  for (const m of text.matchAll(pattern)) {
    const term = m[0];
    // 数字だけ・長すぎる塊・一般語は用語のヒントにならない
    if (term.length > 20 || /^[0-9ー]+$/.test(term) || STOP_WORDS.has(term)) continue;
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, MAX_TERMS)
    .map(([term]) => term);
}

/**
 * 文字起こしに渡すヒント文を組み立てる。
 * Whisperは「その音声の続きらしい自然な文」を期待するので、単語の羅列ではなく
 * 授業の一場面として読める短い日本語にする。
 */
export function buildVocabPrompt(title: string, pageTexts: string[]): string {
  const head = `${title.trim()}の授業です。`;
  const terms = extractTerms(pageTexts.join(' '));
  if (terms.length === 0) return title.trim() ? head : '';

  const picked: string[] = [];
  let len = head.length + 'などの用語が出てきます。'.length;
  for (const term of terms) {
    if (len + term.length + 1 > MAX_PROMPT_CHARS) break;
    picked.push(term);
    len += term.length + 1;
  }
  if (picked.length === 0) return head;
  return `${head}${picked.join('、')}などの用語が出てきます。`;
}

// 授業ごとに1回作れば十分なのでキャッシュする（中身が空のときは次回また作り直す）
const cache = new Map<string, string>();

/** その授業のヒント文。PDFの本文がまだ保存されていなければタイトルだけ、無ければ空文字 */
export async function lessonVocabPrompt(lessonId: string): Promise<string> {
  const cached = cache.get(lessonId);
  if (cached) return cached;
  const [lesson] = await db
    .select({ title: schema.lessons.title, pdfPageTexts: schema.lessons.pdfPageTexts })
    .from(schema.lessons)
    .where(eq(schema.lessons.id, lessonId));
  if (!lesson) return '';
  const prompt = buildVocabPrompt(lesson.title, (lesson.pdfPageTexts ?? []) as string[]);
  // 用語まで入ったものだけキャッシュする（授業中にPDF本文が後から届くことがあるため）
  if (prompt.includes('などの用語')) cache.set(lessonId, prompt);
  return prompt;
}
