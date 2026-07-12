import fs from 'node:fs';
import { config } from '../config';
import { extractRangeToWav } from './audio';

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒`;
}

/**
 * 指定タイムスタンプ範囲の音声を文字起こしする。
 * 授業中の「振り返り提案」（範囲を絞ったクリップ）と授業後の全体文字起こしの
 * 両方がこの同じ関数を使う。
 */
export async function transcribeRange(
  lessonId: string,
  startMs: number,
  endMs: number
): Promise<{ text: string; provider: string } | null> {
  if (config.transcribeProvider === 'openai') {
    const wavPath = await extractRangeToWav(lessonId, startMs, endMs);
    if (!wavPath) return null;
    try {
      const text = await transcribeWithWhisper(wavPath);
      return { text, provider: 'openai-whisper' };
    } finally {
      fs.unlink(wavPath, () => {});
    }
  }

  // mock: キー無しで全フローを検証するためのダミー文字起こし
  return {
    text:
      `（モック文字起こし）${fmtMs(startMs)}から${fmtMs(endMs)}の区間で、` +
      `先生が教材の内容を説明しています。TRANSCRIBE_PROVIDER=openai と OPENAI_API_KEY を設定すると実際の文字起こしになります。`,
    provider: 'mock',
  };
}

async function transcribeWithWhisper(wavPath: string): Promise<string> {
  if (!config.openaiApiKey) throw new Error('OPENAI_API_KEY が設定されていません');
  const form = new FormData();
  const buf = await fs.promises.readFile(wavPath);
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'clip.wav');
  form.append('model', 'whisper-1');
  form.append('language', 'ja');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.openaiApiKey}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Whisper API エラー: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { text: string };
  return data.text;
}
