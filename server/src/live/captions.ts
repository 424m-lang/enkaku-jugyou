import { and, asc, eq } from 'drizzle-orm';
import type { CaptionLine, TranscriptSegment } from '@shared';
import { db, schema } from '../db';
import type { LiveSession } from './liveSessions';

/**
 * ブラウザ音声認識の確定行が、この範囲にあるWhisperの区間と同じ発話だとみなす幅。
 *
 * ブラウザ音声認識の時刻は「発話が終わって確定した瞬間」なので、Whisperが付ける
 * 発話開始の時刻より必ず後ろにずれる。逆に数百msだけ前に出ることもある。
 */
const MATCH_LEAD_MS = 2_000; // Whisperの区間開始より、これだけ前まで許す
const MATCH_TAIL_MS = 8_000; // Whisperの区間終了より、これだけ後まで許す

/**
 * Whisperが無音に対して出しがちな決まり文句。
 *
 * 時刻の突き合わせでほとんど落ちるが、実際の発話のすぐ後ろに続けて出た場合は
 * 残ってしまうため、完全一致するものだけを弾く（授業中に本当に言う可能性が低い文）。
 */
const HALLUCINATION_PHRASES = new Set([
  'ご視聴ありがとうございました',
  'ご視聴ありがとうございました。',
  'ありがとうございました',
  'ありがとうございました。',
  'おわり',
  '終わり',
  'END',
  'Thank you.',
  'Thanks for watching!',
]);

/** 重なりを落として時系列に並べる（ローリング文字起こしは前を少し重ねているため） */
function dedupe(segments: TranscriptSegment[]): TranscriptSegment[] {
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs);
  const out: TranscriptSegment[] = [];
  let until = -Infinity;
  for (const seg of sorted) {
    if (seg.startMs < until - 500) continue;
    out.push(seg);
    until = Math.max(until, seg.endMs);
  }
  return out;
}

async function loadWhisperSegments(lessonId: string): Promise<TranscriptSegment[]> {
  const rows = await db
    .select({ segments: schema.transcripts.segments })
    .from(schema.transcripts)
    .where(and(eq(schema.transcripts.lessonId, lessonId), eq(schema.transcripts.scope, 'clip')));
  const segments: TranscriptSegment[] = [];
  for (const r of rows) {
    if (Array.isArray(r.segments)) segments.push(...(r.segments as TranscriptSegment[]));
  }
  return dedupe(segments).filter((seg) => seg.text.trim());
}

async function loadLiveLines(lessonId: string): Promise<{ tMs: number; text: string }[]> {
  const events = await db
    .select({ tMs: schema.timelineEvents.tMs, payload: schema.timelineEvents.payload })
    .from(schema.timelineEvents)
    .where(and(eq(schema.timelineEvents.lessonId, lessonId), eq(schema.timelineEvents.type, 'caption')))
    .orderBy(asc(schema.timelineEvents.tMs));
  return events
    .map((e) => ({ tMs: e.tMs, text: String((e.payload as { text?: string }).text ?? '').trim() }))
    .filter((l) => l.text);
}

/**
 * 字幕の履歴を組み立てる。
 *
 * 出所が2つある。ブラウザ音声認識（ライブの帯に出したもの）と、サーバ側のWhisper。
 * Whisperのほうが専門用語に強い（スライドPDFから作った用語ヒントが効く）ので、
 * 読み返すときは可能な限りWhisperの文に差し替えたい。
 *
 * ただしWhisperは無音区間に対して実在しない文を作ることがある。単純に時刻で
 * 「ここから先はライブ、手前はWhisper」と切ってしまうと、実際に話した内容が消えて
 * 幻聴だけが残る、という入れ替わりが起きる。
 *
 * そこで「いつ人が話したか」はブラウザ音声認識を正とし、Whisperは
 * 同じ時刻に重なるものだけを言い換えとして採用する。重なる相手がいないWhisperの区間は
 * 誰も話していない時間に出てきた文なので落とす。
 *
 * 例外として、ライブの行が1つも無い授業（先生がChrome・Edge以外を使っていた等）は
 * 突き合わせる相手がいないため、Whisperをそのまま並べる。
 */
export async function captionHistory(s: LiveSession): Promise<CaptionLine[]> {
  const liveLines = await loadLiveLines(s.lessonId);
  if (!s.aiSettings.whisperCaptionHistory) {
    return liveLines.map((line) => ({ ...line, source: 'live' as const }));
  }
  const segments = await loadWhisperSegments(s.lessonId);

  const notHallucination = (text: string) => !HALLUCINATION_PHRASES.has(text.trim());

  if (liveLines.length === 0) {
    return segments
      .filter((seg) => notHallucination(seg.text))
      .map((seg) => ({ tMs: seg.startMs, text: seg.text.trim(), source: 'whisper' as const }));
  }

  const supersededLive = new Set<number>();
  const out: CaptionLine[] = [];

  for (const seg of segments) {
    if (!notHallucination(seg.text)) continue;
    const from = seg.startMs - MATCH_LEAD_MS;
    const to = seg.endMs + MATCH_TAIL_MS;
    let matched = false;
    for (let i = 0; i < liveLines.length; i++) {
      if (liveLines[i].tMs < from) continue;
      if (liveLines[i].tMs > to) break;
      supersededLive.add(i);
      matched = true;
    }
    // 誰も話していない時間に出てきた文は採らない（Whisperの幻聴）
    if (matched) out.push({ tMs: seg.startMs, text: seg.text.trim(), source: 'whisper' });
  }

  // Whisperがまだ追いついていない／認識できなかった分は、ライブの文をそのまま残す
  liveLines.forEach((l, i) => {
    if (!supersededLive.has(i)) out.push({ tMs: l.tMs, text: l.text, source: 'live' });
  });

  return out.sort((a, b) => a.tMs - b.tMs);
}
