import fs from 'node:fs';
import path from 'node:path';
import { and, eq, gt, gte, inArray, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { EndLessonCheck, TimelineEventType, TranscriptSegment } from '@shared';
import { db, schema } from '../db';
import { findTalkEnd, getAudioParts, truncateAudioFile } from '../ai/audio';
import { lessonDirPath } from '../storage';
import { tMs, type LiveSession } from './liveSessions';

/**
 * 終了の押し忘れの判定。
 *
 * 「授業を終了」を押した時点で、授業の動きが長く途切れていれば、
 * 授業はそのあたりで終わっていたものとして終了時刻の候補を返す。
 * 決めるのは先生で、ここは候補を出すだけ。テストや個人作業のように、
 * 操作も声も無いまま授業が続いていることがあるため。
 */

/** 授業の動きがこれだけ途切れていれば、終了時刻の候補を出す */
const IDLE_BEFORE_SUGGEST_MS = 30 * 60_000;
/**
 * 終了を押す直前のこの時間の動きは、途切れの判定から外す。
 * 翌日に戻ってきた先生がスライドの上でマウスを動かす（ポインターが記録される）、
 * どこまで進んだかスライドをめくって確かめる、といった動きで候補が出なくならないようにする
 */
const RETURN_WINDOW_MS = 10 * 60_000;
/** 最後の動きのあとも先生の話が続いていないか、録音で調べる長さ */
const TALK_SEARCH_MS = 15 * 60_000;
/** 候補の時刻に足す余白。最後のひと言が途中で切れないようにする */
const END_PADDING_MS = 60_000;

/**
 * 授業の動きとして数える記録。
 * audio_part は数えない。先生が授業の画面を開き直すだけで録音が始まり直し、
 * 翌日に終了を押しに来たときにも記録されるため
 */
const ACTIVITY_EVENT_TYPES: TimelineEventType[] = [
  'slide_change',
  'stroke',
  'pointer',
  'clear_slide',
  'task_progress',
  'caption',
];

/**
 * 授業の動きのうち、cutoffMs 以前で最後のものと、cutoffMs より後で最初のもの
 * （どちらも授業開始からのms。無ければ null）。
 *
 * 生徒の接続は数えない。タブを開いたままの端末は翌日まで繋がっていることがあり、
 * サーバの再起動でも全員の最終接続時刻が書き換わるため
 */
async function activityAround(
  lessonId: string,
  cutoffMs: number
): Promise<{ before: number | null; after: number | null }> {
  const cutoff = Math.floor(cutoffMs);
  const around = (col: AnyColumn): { before: SQL<number | null>; after: SQL<number | null> } => ({
    before: sql<number | null>`max(${col}) filter (where ${col} <= ${cutoff})`,
    after: sql<number | null>`min(${col}) filter (where ${col} > ${cutoff})`,
  });
  const p = schema.polls;
  const [[events], [reactions], [answers], [polls]] = await Promise.all([
    db
      .select(around(schema.timelineEvents.tMs))
      .from(schema.timelineEvents)
      .where(
        and(
          eq(schema.timelineEvents.lessonId, lessonId),
          inArray(schema.timelineEvents.type, ACTIVITY_EVENT_TYPES)
        )
      ),
    db
      .select(around(schema.reactions.tMs))
      .from(schema.reactions)
      .where(eq(schema.reactions.lessonId, lessonId)),
    db
      .select(around(schema.pollAnswers.answeredAtMs))
      .from(schema.pollAnswers)
      .where(eq(schema.pollAnswers.lessonId, lessonId)),
    db
      .select({
        openedBefore: around(p.openedAtMs).before,
        openedAfter: around(p.openedAtMs).after,
        closedBefore: around(p.closedAtMs).before,
        closedAfter: around(p.closedAtMs).after,
      })
      .from(p)
      .where(eq(p.lessonId, lessonId)),
  ]);
  const pick = (values: unknown[], f: (...n: number[]) => number): number | null => {
    const nums = values.filter((v) => v !== null && v !== undefined).map(Number);
    return nums.length > 0 ? f(...nums) : null;
  };
  return {
    before: pick(
      [events?.before, reactions?.before, answers?.before, polls?.openedBefore, polls?.closedBefore],
      Math.max
    ),
    after: pick(
      [events?.after, reactions?.after, answers?.after, polls?.openedAfter, polls?.closedAfter],
      Math.min
    ),
  };
}

export async function checkLessonEnd(s: LiveSession): Promise<EndLessonCheck> {
  const nowMs = tMs(s);
  const { before, after } = await activityAround(s.lessonId, nowMs - RETURN_WINDOW_MS);
  // 途切れの始まり（最後の動き）と終わり（戻ってきてからの最初の動き。無ければ今）
  const lastMs = Math.min(nowMs, before ?? 0);
  const resumedMs = Math.min(nowMs, after ?? nowMs);
  const base = {
    startedAtEpochMs: s.startedAtEpochMs ?? Date.now() - nowMs,
    nowMs,
    lastActivityMs: lastMs,
    quietMs: Math.max(0, resumedMs - lastMs),
  };
  if (base.quietMs < IDLE_BEFORE_SUGGEST_MS) return { ...base, suggestedEndMs: null };

  // 締めくくりの話はスライドの操作を伴わないことが多いので、声が続いていればそこまで延ばす
  const talkEndMs = await findTalkEnd(s.lessonId, lastMs, Math.min(resumedMs, lastMs + TALK_SEARCH_MS));
  return { ...base, suggestedEndMs: Math.min(resumedMs, talkEndMs + END_PADDING_MS) };
}

// ---- 選んだ終了時刻より後の録音を消す ----
//
// 終了を押し忘れたあいだの録音には、授業の後の会話（タブを開いたまま職員室へ移った、など）が
// 入りうる。復習動画の公開ページは録音ファイルをそのまま配るので、再生側で止めるだけでは
// URLから続きを取得できてしまう。先生が手前の終了時刻を選んだときは、ファイルそのものを切る。

/**
 * endMs（授業開始からのms）より後の録音を消す。授業を終えた（録音を閉じた）あとに呼ぶこと。
 * - endMs をまたぐ録音は、endMs までに切り詰める
 * - endMs より後に始まった録音は、ファイルとタイムラインの記録ごと消す
 *
 * 失敗しても投げない（授業はもう終わっているため。記録だけ残す）
 */
export async function discardRecordingAfter(lessonId: string, endMs: number): Promise<void> {
  try {
    const parts = await getAudioParts(lessonId);
    const dir = lessonDirPath(lessonId);
    for (const [i, part] of parts.entries()) {
      const file = path.join(dir, part.file);
      if (part.startMs >= endMs) {
        fs.rmSync(file, { force: true });
        continue;
      }
      // 次の録音が endMs より前に始まっていれば、この録音は endMs までに終わっている
      const nextStartMs = parts[i + 1]?.startMs ?? Number.POSITIVE_INFINITY;
      if (nextStartMs > endMs && fs.existsSync(file)) {
        await truncateAudioFile(file, endMs - part.startMs);
      }
    }
    await db
      .delete(schema.timelineEvents)
      .where(
        and(
          eq(schema.timelineEvents.lessonId, lessonId),
          eq(schema.timelineEvents.type, 'audio_part'),
          gte(schema.timelineEvents.tMs, endMs)
        )
      );
  } catch (err) {
    console.error('[lesson-end] 終了時刻より後の録音を消せませんでした', err);
  }
}

/**
 * endMs より後の、授業中の文字起こし（scope='clip'）を消す。消した録音を文字にしたものなので、同じ扱いにする。
 * 授業中の文字起こしと並べて直列に呼ぶこと（runAfterTranscription）。途中の文字起こしが後から書き足すため
 */
export async function discardTranscriptsAfter(lessonId: string, endMs: number): Promise<void> {
  const rows = await db
    .select()
    .from(schema.transcripts)
    .where(
      and(
        eq(schema.transcripts.lessonId, lessonId),
        eq(schema.transcripts.scope, 'clip'),
        gt(schema.transcripts.rangeEndMs, endMs)
      )
    );
  for (const row of rows) {
    if (row.rangeStartMs >= endMs) {
      await db.delete(schema.transcripts).where(eq(schema.transcripts.id, row.id));
      continue;
    }
    const kept = ((row.segments ?? []) as TranscriptSegment[]).filter((seg) => seg.startMs < endMs);
    await db
      .update(schema.transcripts)
      .set({ rangeEndMs: endMs, segments: kept, text: kept.map((seg) => seg.text).join('') })
      .where(eq(schema.transcripts.id, row.id));
  }
}
