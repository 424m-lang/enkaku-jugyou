# 遠隔授業 理解度フィードバックシステム

遠隔授業（遠方の学校への配信・自宅受講・複数拠点同時配信）で、対面授業では自然に得られていた「生徒の反応・理解度」を先生が把握できるようにするシステムです。

**映像は使いません。** 音声（Opus）とスライド（PDF）＋軽量なベクターデータ（書き込み・ポインター座標）だけで授業を成立させ、不安定な回線でも動作するように設計されています。

## 主な機能

| 機能 | 説明 |
|---|---|
| 授業配信 | PDFスライド + 先生の音声（低遅延Opusストリーミング）+ 書き込み/ポインターのリアルタイム共有 |
| 白紙スライド挿入 | 授業中にその場で白紙ページを差し込み、補足説明に使える（元のPDFは不変） |
| リアクション | 生徒がボタン（既定: わかった/わからない、授業ごとにカスタマイズ可）とコメントを送信。オフライン時はキューに保持し回線復旧後に元の時刻で再送 |
| 単一タイムライン | 音声・スライド切替・書き込み・ポインター・リアクションを全て「授業開始からの経過ミリ秒」で記録 |
| クリップ | 各リアクションは連続録音ファイルへの軽量な参照（-15秒〜+5秒）。音声はコピーしないため全反応を漏れなく記録できる |
| 振り返りタイム | 反応集中（既定: 3人以上）または一定時間ごとに先生へ通知（対応するまで消えない）。反応が集中した区間だけを文字起こし→AIが「今振り返るべき内容」を提案 |
| 授業後の同期再生 | 録音の再生位置に合わせて、その時点のスライド・書き込み・ポインターを自動再現。クリップ単位の切り抜き再生も可能 |
| AI要約 | 授業全体の文字起こし＋反応集中箇所を踏まえた要約（振り返り提案と同じパイプラインを全体に適用） |
| 統計 | 反応の時系列推移、話速（文字/分）との相関、生徒別の反応履歴 |

## 技術構成

```
client/  React + Vite + pdf.js + socket.io-client（先生・生徒共通のSPA）
server/  Node.js + Fastify + Socket.IO + Drizzle ORM
shared/  クライアント・サーバ共有の型定義
```

- **DB**: PostgreSQL（`DATABASE_URL`）。未設定時はPGlite（ローカルファイルDB）で動作するため、開発はゼロ設定で始められます
- **音声**: MediaRecorder(Opus/WebM, 500msチャンク) → Socket.IO → サーバで録音ファイルに追記＋受講者へファンアウト → MediaSourceで再生。TCPベースなので学校のプロキシ環境でも通りやすく、サーバ経由のため複数拠点への同時配信もそのままスケールします
- **スライド**: PDFを参加時に一括ダウンロードし全ページを事前レンダリング（授業中のページ切替は通信ゼロ）
- **AI**: プロバイダ差し替え式。キー無しでも `mock` で全フローが動作します
  - 文字起こし: `TRANSCRIBE_PROVIDER=mock | openai`（OpenAI Whisper）
  - 要約・提案: `SUMMARY_PROVIDER=mock | anthropic | openai`（Claude API 既定 `claude-opus-4-8` / OpenAI 既定 `gpt-4o-mini`）
  - **OpenAIキー1つだけで文字起こし＋要約の両方を動かせます**（`TRANSCRIBE_PROVIDER=openai` と `SUMMARY_PROVIDER=openai`）

## セットアップ（ローカル）

前提: Node.js 22+

```bash
npm install
npm run dev
```

- クライアント: http://localhost:5173 （APIは :3000 にプロキシ）
- DBはPGlite（`server/data/`）に自動作成。マイグレーションは起動時に自動適用
- 先生: `/register` でアカウント作成 → ダッシュボードでPDFをアップロードして授業作成
- 生徒: `/join` で授業コード＋表示名を入力（アカウント不要）

環境変数は `.env.example` を `server/.env` にコピーして設定します（`server/` ディレクトリで `dotenv` が読み込みます。ルートに置く場合は起動時のカレントディレクトリに注意）。

### AIを実プロバイダで使う

**OpenAIキー1つで全部**（いちばん簡単）:

```env
TRANSCRIBE_PROVIDER=openai
SUMMARY_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

要約だけAnthropic（Claude）にする場合:

```env
SUMMARY_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
```

※ Claude APIは音声入力に対応していないため、文字起こしは常にOpenAI Whisperを使用します。キーが無い間は `mock` のままで動作確認できます。

### 動作確認ツール

複数の生徒を模擬するスクリプトを同梱しています:

```bash
# node scripts/student-sim.mjs <授業コード> [表示名] [リアクションkind] [遅延ms]
node scripts/student-sim.mjs AB3K7X 生徒A confused 3000
```

3端末分を同時に走らせて「わからない」を送ると、振り返りタイム通知（閾値既定3人）の動作を確認できます。

## デプロイ（クラウド）

単一のNodeサーバがAPI・Socket.IO・ビルド済みクライアントを全て配信します。`Dockerfile` を同梱しているので、Docker対応のPaaS（Render / Railway / Fly.io 等）にそのままデプロイできます。

必要なもの:

1. **PostgreSQL**（Neon / Supabase / 各PaaSのマネージドDB）→ `DATABASE_URL`
2. **永続ディスク**（PDF・録音ファイル用）→ マウント先を `DATA_DIR` に設定（例 `/data`）
3. 環境変数: `SESSION_SECRET`（長いランダム文字列）、AIプロバイダ設定（上記）

Render の例（Blueprint `render.yaml` 同梱）:

```bash
# GitHubにpush後、RenderでBlueprintとして読み込むだけ
# DATABASE_URL と ANTHROPIC_API_KEY 等はダッシュボードで設定
```

注意点:

- 音声配信はWebSocketを使うため、WebSocket対応のプラン/構成にしてください
- ライブ状態（配信中の授業）はサーバのメモリに持つため、**単一インスタンス構成**を前提としています（再起動時はDBから自動復元）
- マイク使用（先生側）とMediaSource再生（生徒側）のため、**HTTPS必須**です（PaaSなら自動）

## 設計メモ

- **タイムライン**: 全イベントを `timeline_events(lesson_id, t_ms, type, payload)` に記録。同期再生・クリップ再生は「任意の時刻を指定して状態を再構成する」だけで実現
- **リアクションの重複処理**: 同一生徒×同一ボタンの5秒未満の連打はサーバ側で1回に集約（誤タップ対策）。それ以上の間隔は「まだわからない」という継続シグナルとして別レコードで保持。複数生徒の近接反応は表示時に「反応クラスタ」へ集約し、人数の多い瞬間を優先して先生に提示
- **録音**: 1レッスン=原則1つの連続WebMファイル。先生の画面リロード等で録音が再開された場合のみ新パートに切替え、その境界も `audio_part` イベントとしてタイムラインに記録
- **プライバシー（Phase 2準備）**: `participants.consent_status` と `lessons.anonymize_mode` をスキーマに用意済み（ロジックは未実装）。生徒はアカウント不要・表示名のみで参加

## 制限事項（Phase 1）

- 文字起こしの実行には OpenAI API キーが必要（Whisper）。長時間授業では自動分割は未実装（約25MB/リクエストのAPI制限）
- 複数サーバインスタンスへのスケールアウトは未対応（Socket.IOアダプタ等が必要）
- 同意管理・匿名化モード・復習資料の自動生成などは Phase 2 の対象
