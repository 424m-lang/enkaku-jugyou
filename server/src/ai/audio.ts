import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { and, asc, eq } from 'drizzle-orm';
import ffmpegPath from 'ffmpeg-static';
import { db, schema } from '../db';
import { lessonDir } from '../storage';

export type AudioPartInfo = { file: string; startMs: number };

/** タイムライン上の audio_part イベントから録音パート一覧を取得 */
export async function getAudioParts(lessonId: string): Promise<AudioPartInfo[]> {
  const rows = await db
    .select()
    .from(schema.timelineEvents)
    .where(
      and(eq(schema.timelineEvents.lessonId, lessonId), eq(schema.timelineEvents.type, 'audio_part'))
    )
    .orderBy(asc(schema.timelineEvents.tMs));
  return rows.map((r) => ({ file: (r.payload as { file: string }).file, startMs: r.tMs }));
}

/**
 * 連続音声ファイルから指定タイムスタンプ範囲を切り出し、STT用のWAV(16kHz mono)にする。
 * 元の音声データは複製せず、必要なときだけ一時ファイルとして生成する。
 * 戻り値は一時ファイルパス（呼び出し側で削除すること）。
 */
export async function extractRangeToWav(
  lessonId: string,
  startMs: number,
  endMs: number
): Promise<string | null> {
  if (!ffmpegPath) throw new Error('ffmpeg が見つかりません');
  const parts = await getAudioParts(lessonId);
  if (parts.length === 0) return null;

  // 範囲の開始を含むパートを選ぶ（パート跨ぎの場合はパート末尾まで）
  let part: AudioPartInfo = parts[0];
  for (const p of parts) {
    if (p.startMs <= startMs) part = p;
  }
  const srcPath = path.join(lessonDir(lessonId), part.file);
  if (!fs.existsSync(srcPath)) return null;

  const offsetSec = Math.max(0, (startMs - part.startMs) / 1000);
  const durationSec = Math.max(0.5, (endMs - startMs) / 1000);
  const outPath = path.join(os.tmpdir(), `clip_${lessonId}_${crypto.randomUUID()}.wav`);

  await new Promise<void>((resolve, reject) => {
    execFile(
      ffmpegPath as string,
      [
        '-y',
        '-ss', offsetSec.toFixed(3),
        '-t', durationSec.toFixed(3),
        '-i', srcPath,
        '-ar', '16000',
        '-ac', '1',
        '-f', 'wav',
        outPath,
      ],
      { timeout: 120_000 },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(`ffmpeg失敗: ${stderr?.slice(-500)}`));
        else resolve();
      }
    );
  });

  return fs.existsSync(outPath) ? outPath : null;
}
