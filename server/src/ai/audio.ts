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

  const durationSec = Math.max(0.5, (endMs - startMs) / 1000);
  const outPath = path.join(os.tmpdir(), `clip_${lessonId}_${crypto.randomUUID()}.wav`);

  // 録音器の再起動・形式変更をまたぐ範囲では、関係する全パートをタイムライン上の
  // 正しい位置へ重ねる。以前は開始時刻を含む1ファイルだけを読み、残りが欠けていた。
  const overlaps = parts.flatMap((part, i) => {
    const partEndMs = parts[i + 1]?.startMs ?? endMs;
    const fromMs = Math.max(startMs, part.startMs);
    const toMs = Math.min(endMs, partEndMs);
    const srcPath = path.join(lessonDir(lessonId), part.file);
    if (toMs <= fromMs || !fs.existsSync(srcPath)) return [];
    return [{
      srcPath,
      offsetSec: Math.max(0, (fromMs - part.startMs) / 1000),
      durationSec: (toMs - fromMs) / 1000,
      delayMs: fromMs - startMs,
    }];
  });
  if (overlaps.length === 0) return null;

  const buildArgs = (used: typeof overlaps): string[] => {
    const a = [
      '-y',
      // 無音の土台を置くことで、録音再開までの隙間も時刻どおりに保つ
      '-f', 'lavfi', '-t', durationSec.toFixed(3),
      '-i', 'anullsrc=r=16000:cl=mono',
    ];
    for (const part of used) {
      a.push(
        '-ss', part.offsetSec.toFixed(3),
        '-t', Math.max(0.001, part.durationSec).toFixed(3),
        '-i', part.srcPath
      );
    }
    const filters = [
      `[0:a]aformat=sample_fmts=fltp:channel_layouts=mono,atrim=duration=${durationSec.toFixed(3)},asetpts=PTS-STARTPTS[base]`,
      ...used.map(
        (part, i) =>
          `[${i + 1}:a]aresample=16000,aformat=sample_fmts=fltp:channel_layouts=mono,` +
          `asetpts=PTS-STARTPTS,adelay=${Math.max(0, Math.round(part.delayMs))}:all=1[a${i}]`
      ),
      `[base]${used.map((_, i) => `[a${i}]`).join('')}amix=inputs=${used.length + 1}:` +
        `duration=first:dropout_transition=0:normalize=0,atrim=duration=${durationSec.toFixed(3)},` +
        'asetpts=PTS-STARTPTS[out]',
    ];
    a.push(
      '-filter_complex', filters.join(';'),
      '-map', '[out]',
      '-ar', '16000',
      '-ac', '1',
      '-f', 'wav',
      outPath
    );
    return a;
  };

  /** 失敗したら標準エラーの末尾を返す。成功なら null */
  const runFfmpeg = (a: string[]): Promise<string | null> =>
    new Promise((resolve) => {
      execFile(ffmpegPath as string, a, { timeout: 120_000 }, (err, _stdout, stderr) =>
        resolve(err ? (stderr?.slice(-500) ?? String(err)) : null)
      );
    });

  let failed = await runFfmpeg(buildArgs(overlaps));

  if (failed && overlaps.length > 1) {
    // **壊れて読めないファイルが1つ混じると、ffmpegはコマンドごと中断する。**
    // ファイルが「無い」場合は上の existsSync で除けているが、「あるが読めない」
    // 場合（書き込み途中でプロセスが落ちた、形式が食い違うなど）はここに来る。
    // そのままだと授業まるごとの文字起こし・コメント解析が何も返さなくなるので、
    // 読めるものだけで組み直して一度やり直す。
    // 健全なときは走らないので、通常の切り出しは重くならない
    const readable: typeof overlaps = [];
    for (const part of overlaps) {
      const bad = await runFfmpeg(['-v', 'error', '-i', part.srcPath, '-t', '0.1', '-f', 'null', '-']);
      if (!bad) readable.push(part);
      else console.error('[audio] 読めない録音ファイルを飛ばします:', part.srcPath);
    }
    if (readable.length > 0 && readable.length < overlaps.length) {
      failed = await runFfmpeg(buildArgs(readable));
    }
  }

  if (failed) {
    // 最後の録音がどこで終わったかはDBに無いため、要求された終わりまで続いていると
    // 仮定している。実際にはもっと早く止まっていることがあり、その区間は何も読めない。
    // **投げると呼び出し元の解析ごと落ちる**ので、切り出せなかったこととして扱う
    console.error('[audio] 音声の切り出しに失敗:', failed);
    fs.rmSync(outPath, { force: true });
    return null;
  }

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
 * 文字起こしの前後で使う音声の下調べ。10分の音声でも1秒かからない。
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

// ---- 終了の押し忘れ ----

/**
 * 録音ファイルを先頭から durationMs までに切り詰める。中身は再エンコードせずに写す。
 *
 * 一時ファイルへ書き出してから元のファイルと置き換えるので、途中で失敗しても元のファイルは壊れない。
 * 失敗したときは元のファイルを残して false を返す（呼び出し側で記録を残す）
 */
export async function truncateAudioFile(filePath: string, durationMs: number): Promise<boolean> {
  if (!ffmpegPath || durationMs <= 0) return false;
  const tmpPath = `${filePath}.trim`;
  const container = filePath.endsWith('.mp4')
    ? ['-movflags', '+faststart', '-f', 'mp4']
    : ['-f', 'webm'];
  const failed = await new Promise<string | null>((resolve) => {
    execFile(
      ffmpegPath as string,
      [
        '-y', '-v', 'error',
        '-i', filePath,
        '-t', (durationMs / 1000).toFixed(3),
        '-map', '0:a', '-c', 'copy',
        ...container,
        tmpPath,
      ],
      { timeout: 300_000 },
      (err, _stdout, stderr) => resolve(err ? (stderr?.slice(-500) || String(err)) : null)
    );
  });
  if (failed) {
    fs.rmSync(tmpPath, { force: true });
    console.error('[audio] 録音を切り詰められませんでした:', filePath, failed);
    return false;
  }
  await fs.promises.rename(tmpPath, filePath);
  return true;
}

/** 声の大きさの基準をとる範囲。調べ始める時刻より前の、授業中の録音を使う */
const TALK_REFERENCE_MS = 10 * 60_000;
/** 話の途中の間として扱う長さの上限。これより長く静かなら、話はそこで終わったとみなす */
const TALK_MAX_PAUSE_MS = 2 * 60_000;

/**
 * fromMs のあとも先生の話が続いていたかを録音で調べ、話の終わりの時刻を返す。
 * 授業の終了を押し忘れたときに、終了時刻の候補を決めるために使う。
 *
 * 声かどうかの基準は、**fromMs より前の授業中の録音**の最大音量から決める。
 * 調べる範囲そのものを基準にすると（analyzeAudio の相対の見方）、
 * 誰もいない部屋の暗騒音だけの録音で「全部が声」と出てしまうため。
 * 基準の範囲に声が入っていなかったときは、絶対の閾値（QUIET_ABSOLUTE_DB）より下げない。
 *
 * 音が途切れても TALK_MAX_PAUSE_MS 以内に再び鳴れば話の続きとみなし、
 * それより長く静かならそこで打ち切る。だいぶ後に一度だけ鳴った物音で終わりを延ばさないため。
 *
 * 録音が無い・調べられないときは fromMs をそのまま返す（候補を延ばさない）。
 */
export async function findTalkEnd(lessonId: string, fromMs: number, toMs: number): Promise<number> {
  if (!ffmpegPath || toMs <= fromMs) return fromMs;
  const temps: string[] = [];
  try {
    const tailPath = await extractRangeToWav(lessonId, fromMs, toMs);
    if (!tailPath) return fromMs;
    temps.push(tailPath);

    let thresholdDb = QUIET_ABSOLUTE_DB;
    if (fromMs > 0) {
      const refPath = await extractRangeToWav(
        lessonId,
        Math.max(0, fromMs - TALK_REFERENCE_MS),
        fromMs
      );
      if (refPath) {
        temps.push(refPath);
        const peak = /max_volume:\s*(-?[\d.]+) dB/.exec(await runFilter(refPath, 'volumedetect'));
        if (peak) {
          thresholdDb = Math.max(QUIET_ABSOLUTE_DB, Number(peak[1]) - SILENCE_BELOW_PEAK_DB);
        }
      }
    }

    const spanMs = toMs - fromMs;
    const silent = parseSilence(
      await runFilter(tailPath, `silencedetect=noise=${thresholdDb.toFixed(1)}dB:d=${SILENCE_MIN_SEC}`)
    );
    // 静かな区間の隙間が、音が鳴っていた区間
    const sounds: { startMs: number; endMs: number }[] = [];
    let cursor = 0;
    for (const q of silent) {
      if (q.startMs > cursor) sounds.push({ startMs: cursor, endMs: Math.min(q.startMs, spanMs) });
      cursor = Math.max(cursor, q.endMs);
    }
    if (cursor < spanMs) sounds.push({ startMs: cursor, endMs: spanMs });

    let talkEnd = 0;
    for (const r of sounds) {
      if (r.startMs - talkEnd > TALK_MAX_PAUSE_MS) break;
      talkEnd = Math.max(talkEnd, r.endMs);
    }
    return fromMs + Math.min(talkEnd, spanMs);
  } catch (err) {
    console.error('[audio] 話の終わりを調べられませんでした', err);
    return fromMs;
  } finally {
    for (const p of temps) fs.rmSync(p, { force: true });
  }
}
