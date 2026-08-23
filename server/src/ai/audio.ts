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

/** 無音とみなす音量。その音声の中で最も大きい音から何dB下か（絶対値で決めない理由は下記） */
const SILENCE_BELOW_PEAK_DB = 20;
/** これより短い静けさは、単語の切れ目なので無音区間として数えない */
const SILENCE_MIN_SEC = 0.8;

/** ffmpegのフィルタを1回通して、標準エラーに出るログを読む */
function runFilter(wavPath: string, filter: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath as string,
      ['-hide_banner', '-i', wavPath, '-af', filter, '-f', 'null', '-'],
      { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(`ffmpeg失敗: ${stderr?.slice(-500)}`));
        else resolve(stderr ?? '');
      }
    );
  });
}

/** 誰の声も入っていないとみなす絶対的な音量（実測: 暗騒音は概ねこれを下回る） */
const QUIET_ABSOLUTE_DB = -40;

/** silencedetect のログから無音区間を取り出す */
function parseSilence(log: string): { startMs: number; endMs: number }[] {
  const ranges: { startMs: number; endMs: number }[] = [];
  let start: number | null = null;
  for (const m of log.matchAll(/silence_(start|end):\s*(-?[\d.]+)/g)) {
    const sec = Number(m[2]);
    if (m[1] === 'start') start = sec;
    else if (start !== null) {
      ranges.push({ startMs: Math.round(start * 1000), endMs: Math.round(sec * 1000) });
      start = null;
    }
  }
  // 最後まで無音のまま終わった場合は末尾まで
  if (start !== null) {
    ranges.push({ startMs: Math.round(start * 1000), endMs: Number.MAX_SAFE_INTEGER });
  }
  return ranges;
}

export type AudioAnalysis = {
  /** その録音の中で相対的に静かな区間（同じ録音の中での発話と沈黙の切り分け） */
  silentRanges: { startMs: number; endMs: number }[];
  /** 声が出ている時間の割合（0〜1）。録音全体が小さくても、その中での比率は正しく出る */
  speechFraction: number;
  /** 絶対的に静かな時間の割合（0〜1）。録音全体に声が入っていないかの判断に使う */
  quietFraction: number;
};

/**
 * 文字起こしの前後で使う音声の下調べ。10分ぶんでも1秒かからない。
 *
 * 2つの見方を併用する。どちらか片方では判断を誤るため:
 * - 相対（その音声自身の最大音量から20dB下）… 同じ録音の中で発話と沈黙を分ける。
 *   実測で、暗騒音の最大音量(-36dB)と正しく聞き取れた小声の発話(-32dB)はほぼ同じで、
 *   固定の閾値では本物の発話まで捨ててしまうため、この見方が要る。
 *   ただし一様な暗騒音だけの音声では「全部が発話」と出てしまう
 * - 絶対（-40dB）… 録音全体に声が入っていないことの判断。上の弱点を補う
 */
export async function analyzeAudio(wavPath: string): Promise<AudioAnalysis | null> {
  if (!ffmpegPath) return null;
  const volLog = await runFilter(wavPath, 'volumedetect');
  const peak = /max_volume:\s*(-?[\d.]+) dB/.exec(volLog);
  const durMatch = /time=(\d+):(\d+):([\d.]+)/g;
  let durationMs = 0;
  for (const m of volLog.matchAll(durMatch)) {
    durationMs = Math.round(
      (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000
    );
  }
  if (!peak || durationMs <= 0) return null;

  const relLog = await runFilter(
    wavPath,
    `silencedetect=noise=${(Number(peak[1]) - SILENCE_BELOW_PEAK_DB).toFixed(1)}dB:d=${SILENCE_MIN_SEC}`
  );
  const absLog = await runFilter(
    wavPath,
    `silencedetect=noise=${QUIET_ABSOLUTE_DB}dB:d=${SILENCE_MIN_SEC}`
  );
  const cover = (ranges: { startMs: number; endMs: number }[]): number =>
    ranges.reduce((a, r) => a + (Math.min(r.endMs, durationMs) - r.startMs), 0);
  const silentRanges = parseSilence(relLog);
  return {
    silentRanges,
    speechFraction: Math.max(0, 1 - cover(silentRanges) / durationMs),
    quietFraction: Math.min(1, cover(parseSilence(absLog)) / durationMs),
  };
}

/** その区間がどれだけ無音に覆われているか（0〜1） */
export function silenceRatio(
  seg: { startMs: number; endMs: number },
  silent: { startMs: number; endMs: number }[]
): number {
  const span = seg.endMs - seg.startMs;
  if (span <= 0) return 1;
  let covered = 0;
  for (const s of silent) {
    covered += Math.max(0, Math.min(s.endMs, seg.endMs) - Math.max(s.startMs, seg.startMs));
  }
  return Math.min(1, covered / span);
}
