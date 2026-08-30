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

  // 登録の合言葉。設定すると、先生アカウントの登録にこの文字列が要るようになる。
  // 未設定の場合は登録コードを求めない（ローカル運用や校内限定向け）。
  // インターネットに公開する場合は、勝手に登録されてAI利用料が出るのを防ぐために設定する
  registerCode: process.env.REGISTER_CODE || '',

  // AIプロバイダー
  transcribeProvider: (process.env.TRANSCRIBE_PROVIDER || 'mock') as 'mock' | 'openai',
  summaryProvider: (process.env.SUMMARY_PROVIDER || 'mock') as 'mock' | 'anthropic' | 'openai',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-5.6-luna',

  // コメント整理: 対象は「入力開始時刻のこの時間前」〜「コメント送信時刻」
  insightWindowBeforeMs: Number(process.env.INSIGHT_WINDOW_BEFORE_MS ?? 90_000),
  // 分析範囲がこの間隔以内で近接する既存カードを「同じ事柄か」の統合判定にかける
  insightMergeGapMs: Number(process.env.INSIGHT_MERGE_GAP_MS ?? 30_000),
  // 授業中の要約: 特定した発言の前後この範囲を要約対象にする（二段構えの2段目）
  insightFocusBeforeMs: Number(process.env.INSIGHT_FOCUS_BEFORE_MS ?? 30_000),
  insightFocusAfterMs: Number(process.env.INSIGHT_FOCUS_AFTER_MS ?? 60_000),

  // 授業中のローリング文字起こし: 裏でこの間隔ごとに新しい分を文字起こしして貯める
  liveTranscribeIntervalMs: Number(process.env.LIVE_TRANSCRIBE_INTERVAL_MS ?? 300_000), // 5分
  // 各区切りに直前のこの時間を重ねて文字起こしし、つなぎ目の欠けを防ぐ
  liveTranscribeOverlapMs: Number(process.env.LIVE_TRANSCRIBE_OVERLAP_MS ?? 15_000),
  // 1回の文字起こしはこの長さまで（Whisperの約13分/25MB上限より短く保つ）
  liveTranscribeMaxChunkMs: Number(process.env.LIVE_TRANSCRIBE_MAX_CHUNK_MS ?? 600_000), // 10分

  // 授業後「ボタン」タブのクリップ範囲（反応の30秒前〜15秒後の45秒）
  buttonClipBeforeMs: 30_000,
  buttonClipAfterMs: 15_000,
  // この間隔以内に続いた同じスライドへの反応は、同じ事柄への反応とみなしてまとめる
  buttonMergeGapMs: 20_000,
  // 授業後「コメント」タブ: 対象の発言を探すためにコメントから遡る時間
  commentLookbackMs: 240_000,

  // 復習動画: つまずいた箇所の前後にこれだけ足して、話の流れが追えるようにする
  chapterContextBeforeMs: 60_000,
  chapterContextAfterMs: 60_000,
  // これだけ近い区間はひとつの章にまとめる
  chapterMergeGapMs: 45_000,
  // 章の頭は「そのスライドの説明の最初」まで戻す（戻しすぎないよう上限を設ける）
  chapterSnapBackMaxMs: 180_000,

  // クリップ範囲（反応時刻の前後）
  clipBeforeMs: 15_000,
  clipAfterMs: 5_000,
  // 同一生徒×同一ボタンのデバウンス
  reactionDebounceMs: 5_000,
  // クラスタ結合の間隔
  clusterGapMs: 8_000,
};
