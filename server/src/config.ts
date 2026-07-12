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
  summaryProvider: (process.env.SUMMARY_PROVIDER || 'mock') as 'mock' | 'anthropic',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
  openaiApiKey: process.env.OPENAI_API_KEY || '',

  // 振り返りタイム
  reflectionIntervalMin: Number(process.env.REFLECTION_INTERVAL_MIN ?? 15),
  reflectionThreshold: Number(process.env.REFLECTION_THRESHOLD ?? 3),

  // クリップ範囲（反応時刻の前後）
  clipBeforeMs: 15_000,
  clipAfterMs: 5_000,
  // 同一生徒×同一ボタンのデバウンス
  reactionDebounceMs: 5_000,
  // クラスタ結合の間隔
  clusterGapMs: 8_000,
};
