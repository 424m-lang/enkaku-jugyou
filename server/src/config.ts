import 'dotenv/config';
import path from 'node:path';

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  isProd: process.env.NODE_ENV === 'production',

  // 未設定ならPGlite（ローカルファイルDB）で動作
  databaseUrl: process.env.DATABASE_URL || '',

  // PDF・録音などの保存先
  dataDir: process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(process.cwd(), 'data'),

  sessionSecret: process.env.SESSION_SECRET || 'dev-secret-change-me',

  // AIプロバイダ
  transcribeProvider: (process.env.TRANSCRIBE_PROVIDER || 'mock') as 'mock' | 'openai',
  summaryProvider: (process.env.SUMMARY_PROVIDER || 'mock') as 'mock' | 'anthropic' | 'openai',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',

  // コメント・振り返り: 分析対象は「入力開始時刻のこの時間前」〜「コメント送信時刻」
  insightWindowBeforeMs: Number(process.env.INSIGHT_WINDOW_BEFORE_MS ?? 90_000),
  // 分析範囲がこの間隔以内で近接する既存カードを「同じ事柄か」の統合判定にかける
  insightMergeGapMs: Number(process.env.INSIGHT_MERGE_GAP_MS ?? 30_000),

  // クリップ範囲（反応時刻の前後）
  clipBeforeMs: 15_000,
  clipAfterMs: 5_000,
  // 同一生徒×同一ボタンのデバウンス
  reactionDebounceMs: 5_000,
  // クラスタ結合の間隔
  clusterGapMs: 8_000,
};
