import fs from 'node:fs';
import type { TranscriptSegment } from '@shared';
import { config } from '../config';
import { extractRangeToWav } from './audio';

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒`;
}

export type TranscribeResult = {
  text: string;
  segments: TranscriptSegment[] | null;
  provider: string;
};

/**
 * 指定タイムスタンプ範囲の音声を文字起こしする。
 * 授業中の「振り返り提案」（範囲を絞ったクリップ）と授業後の全体文字起こしの
 * 両方がこの同じ関数を使う。
 */
export async function transcribeRange(
  lessonId: string,
  startMs: number,
  endMs: number
): Promise<TranscribeResult | null> {
  if (config.transcribeProvider === 'openai') {
    const wavPath = await extractRangeToWav(lessonId, startMs, endMs);
    if (!wavPath) return null;
    try {
      const { text, segments } = await transcribeWithWhisper(wavPath);
      // Whisperのタイムスタンプは切り出し範囲の先頭基準 → 授業タイムラインへ補正
      const adjusted = segments?.map((s) => ({
        startMs: s.startMs + startMs,
        endMs: s.endMs + startMs,
        text: s.text,
      }));
      return { text, segments: adjusted ?? null, provider: 'openai-whisper' };
    } finally {
      fs.unlink(wavPath, () => {});
    }
  }

  // mock: キー無しで全フローを検証するためのダミー文字起こし
  // 話速グラフのUI確認用に、10秒ごとの擬似セグメントも生成する
  const samples = [
    'ここでは前のスライドの内容を踏まえて、次の概念について説明しています。',
    '例題を使いながら、つまずきやすいポイントをゆっくり解説しています。',
    '公式の導出過程を、板書の書き込みとあわせて確認しています。',
    '生徒からの反応を見ながら、補足の説明を加えています。',
  ];
  const segments: TranscriptSegment[] = [];
  for (let t = startMs, i = 0; t < endMs; t += 10_000, i++) {
    segments.push({
      startMs: t,
      endMs: Math.min(t + 10_000, endMs),
      text: samples[i % samples.length],
    });
  }
  return {
    text:
      `（モック文字起こし: ${fmtMs(startMs)}〜${fmtMs(endMs)}）` +
      segments.map((s) => s.text).join(''),
    segments,
    provider: 'mock',
  };
}

async function transcribeWithWhisper(
  wavPath: string
): Promise<{ text: string; segments: TranscriptSegment[] | null }> {
  if (!config.openaiApiKey) throw new Error('OPENAI_API_KEY が設定されていません');
  const form = new FormData();
  const buf = await fs.promises.readFile(wavPath);
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'clip.wav');
  form.append('model', 'whisper-1');
  form.append('language', 'ja');
  form.append('response_format', 'verbose_json');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.openaiApiKey}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Whisper API エラー: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    text: string;
    segments?: { start: number; end: number; text: string }[];
  };
  return {
    text: data.text,
    segments:
      data.segments?.map((s) => ({
        startMs: Math.round(s.start * 1000),
        endMs: Math.round(s.end * 1000),
        text: s.text,
      })) ?? null,
  };
}
