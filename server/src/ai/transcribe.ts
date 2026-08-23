import fs from 'node:fs';
import type { TranscriptSegment } from '@shared';
import { config } from '../config';
import { analyzeAudio, extractRangeToWav, silenceRatio, type AudioAnalysis } from './audio';
import { dropLoopedSegments, lessonVocabPrompt, stripVocabEcho } from './vocabPrompt';

/** 区間のこれ以上が無音なら、そこに起きた文字は聞き取りではなく作り話とみなす */
const SILENT_SEGMENT_RATIO = 0.8;
/** これ以上が絶対的に静かなら、その範囲には誰の声も入っていないとみなす */
const SILENT_RANGE_QUIET_FRACTION = 0.95;
/** 声が出ている時間がこれ未満なら、話がまばらすぎて用語のヒントが害になるとみなす */
const HINT_MIN_SPEECH_FRACTION = 0.25;

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
      const audio = await analyzeAudio(wavPath);
      // 誰も話していない範囲は、そもそも問い合わせない。
      // Whisperは声の無い音声に対して必ず何かを書こうとするため、渡せば作り話しか返らない
      // （検証では、暗騒音10分に対して支離滅裂な文が44個生成された）。
      // 呼ばないので、その時間ぶんの料金と待ち時間もかからない
      if (audio && audio.quietFraction >= SILENT_RANGE_QUIET_FRACTION) {
        return { text: '', segments: [], provider: 'openai-whisper' };
      }
      // スライドの用語をヒントとして渡し、その授業の専門用語が崩れにくくする。
      // ただし話がまばらな範囲では、Whisperがヒント文をそのまま書き出したり、
      // そこにある実際の発話まで聞き逃したりするので、あえて渡さない
      const vocab =
        audio && audio.speechFraction < HINT_MIN_SPEECH_FRACTION
          ? ''
          : await lessonVocabPrompt(lessonId);
      const { text, segments } = await transcribeWithWhisper(wavPath, vocab, audio);
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
  wavPath: string,
  vocabPrompt = '',
  audio: AudioAnalysis | null = null
): Promise<{ text: string; segments: TranscriptSegment[] | null }> {
  if (!config.openaiApiKey) throw new Error('OPENAI_API_KEY が設定されていません');
  const form = new FormData();
  const buf = await fs.promises.readFile(wavPath);
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'clip.wav');
  // 発言ごとのタイムスタンプ（segments）が返るのは whisper-1 だけ。
  // このアプリはコメントの位置特定・ブロックの区切り・スライドとの対応付けを
  // すべてこのタイムスタンプに依存しているため、他の文字起こしモデルには替えられない
  form.append('model', 'whisper-1');
  form.append('language', 'ja');
  form.append('response_format', 'verbose_json');
  if (vocabPrompt) form.append('prompt', vocabPrompt);

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
  const segments =
    data.segments?.map((s) => ({
      startMs: Math.round(s.start * 1000),
      endMs: Math.round(s.end * 1000),
      text: s.text,
    })) ?? null;
  if (!segments) return { text: data.text, segments };

  // 声の無い区間に文字が起きていたら、それは聞き取りではなく作り話なので落とす。
  // Whisperは無音に対して「ご視聴ありがとうございました」のような定型文や、
  // ヒント文の写しを出力したり、同じ文を延々とくり返したりする。
  // 3つの見分け方は互いを補うので、すべて通す
  const kept = dropLoopedSegments(stripVocabEcho(segments, vocabPrompt)).filter(
    (seg) => !audio || silenceRatio(seg, audio.silentRanges) < SILENT_SEGMENT_RATIO
  );
  // 落ちたものがあれば全文も作り直す（残ったセグメントと食い違わないように）
  return {
    text: kept.length === segments.length ? data.text : kept.map((s) => s.text).join(''),
    segments: kept,
  };
}
