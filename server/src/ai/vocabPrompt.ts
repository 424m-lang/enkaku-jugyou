import { eq } from 'drizzle-orm';
import type { TranscriptSegment } from '@shared';
import { db, schema } from '../db';

/**
 * 文字起こしに渡す「用語のヒント」を、授業タイトルとスライドPDFの本文から作る。
 *
 * Whisperは prompt に書かれた語を優先して当てにいくので、授業の専門用語や固有名詞
 * （「フーリエ変換」「高知工科大学」など）を渡しておくと、そこの認識が崩れにくくなる。
 * promptは長すぎると無視されたり悪影響が出るため、短く保つ。
 */

/**
 * promptに詰め込む上限。
 * ヒントは長いほど、実際の発話まで引っ張ってしまう副作用が出る
 * （検証では「今回の授業」が、ヒントにあった「機械学習」に引かれて
 * 「機械の授業」と誤認識された）。効く語だけを短く渡す。
 */
const MAX_PROMPT_CHARS = 140;
/** 拾う用語の最大数 */
const MAX_TERMS = 15;

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
    if (!isWorthHinting(term)) continue;
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, MAX_TERMS)
    .map(([term]) => term);
}

/**
 * ヒントとして渡す価値がある語か。
 * Whisperはありふれた日本語（「基礎」「定義」「変換」）はもともと正しく聞き取るので、
 * 渡しても精度は上がらず、実際の発話を引っ張る副作用だけが増える。
 * 聞き間違えられやすいのは固有名詞・カタカナ語・分野特有の複合語なので、そこに絞る。
 */
function isWorthHinting(term: string): boolean {
  if (/[ァ-ヶ]/.test(term)) return true; // カタカナを含む（外来語・専門語）
  if (/[A-Za-z]/.test(term)) return true; // 英字を含む（PBL など）
  return term.length >= 3; // 漢字だけなら3文字以上（「矩形波」は残し「基礎」は落とす）
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

/** ヒント文と聞き取り結果を比べるために、記号・空白を落として文字だけにする */
function normalize(s: string): string {
  return s.replace(/[^0-9A-Za-zぁ-んァ-ヶー一-龥々]/g, '');
}

/** これ以上の長さがヒント文と一致したら、偶然ではなくヒントの写しとみなす */
const ECHO_MIN_CHARS = 12;

/**
 * Whisperがヒント文をそのまま書き出してしまったセグメントを取り除く。
 *
 * Whisperはpromptを「その音声の直前の文」と解釈するため、無音や暗騒音しか無い区間では
 * 続きが作れず、promptをそのまま出力してくることがある。実際に、暗騒音だけの10分を
 * 渡すとヒント文が20回並んだ。音量では暗騒音と小声の発話を区別できない
 * （実測で暗騒音 max -36dB に対し、正しく聞き取れた小声の発話が max -32dB）ため、
 * 事前に無音を弾くのではなく、出てきた写しを後から落とす。
 */
export function stripVocabEcho(
  segments: TranscriptSegment[],
  vocabPrompt: string
): TranscriptSegment[] {
  if (!vocabPrompt) return segments;
  const hint = normalize(vocabPrompt);
  const tail = normalize('などの用語が出てきます');
  return segments.filter((seg) => {
    const t = normalize(seg.text);
    if (!t) return false;
    if (t === hint) return false; // ヒント文そのもの
    if (t.endsWith(tail)) return false; // ヒント文の後半（用語の羅列）
    // ヒント文の一部をそのまま写したもの。短い一致は本当の発言かもしれないので残す
    return !(t.length >= ECHO_MIN_CHARS && hint.includes(t));
  });
}

/** 同じ文がこの回数以上くり返されたら、聞き取りではなくWhisperの空回りとみなす */
const LOOP_MIN_REPEATS = 3;
/** くり返し判定にかける最短の長さ（「はい」などの短い相づちは本当にくり返される） */
const LOOP_MIN_CHARS = 8;

/**
 * 同じ文がくり返し出力されたセグメントを取り除く。
 * Whisperは声の無い区間でしばしば空回りし、同じ文を延々と並べる
 * （検証では暗騒音10分に対して同じ文が20回並んだ）。
 * 授業で同じ文をそのまま3回以上くり返すことはまず無いので、安全に落とせる。
 */
export function dropLoopedSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  const counts = new Map<string, number>();
  for (const seg of segments) {
    const t = normalize(seg.text);
    if (t.length >= LOOP_MIN_CHARS) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return segments.filter((seg) => (counts.get(normalize(seg.text)) ?? 0) < LOOP_MIN_REPEATS);
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
