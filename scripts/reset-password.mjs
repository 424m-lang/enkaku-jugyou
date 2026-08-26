// 先生のパスワードを設定し直す（サーバを管理する人向け）。
//
// このシステムはメールアドレスを預かっていないので、画面から「パスワードを忘れた」を
// 処理できない。かといってアカウントを作り直すと、それまでの授業の記録は
// 元のアカウントに残ったまま開けなくなる。
// 記録を残したまま入り直せるように、DBのパスワードだけを差し替える口をここに置く。
//
// 使い方:
//   node scripts/reset-password.mjs <ログインID>          … 新しいパスワードを聞く
//   node scripts/reset-password.mjs <ログインID> --list    … 登録されているログインIDを見る
//
// 接続先は server/.env と同じ設定を読む（DATABASE_URL があればそちら、無ければPGlite）。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.join(root, 'server');

// server/.env を読む（サーバ本体と同じ設定で動かすため）
const envPath = path.join(serverDir, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const loginId = args.find((a) => !a.startsWith('--'));

if (!loginId && !listOnly) {
  console.error('使い方: node scripts/reset-password.mjs <ログインID>');
  console.error('        node scripts/reset-password.mjs --list   （登録されているIDを見る）');
  process.exit(1);
}

/** DBに繋いで、SQLを実行する関数と後始末を返す */
async function connect() {
  if (process.env.DATABASE_URL) {
    const postgres = (await import('postgres')).default;
    const sql = postgres(process.env.DATABASE_URL, { max: 1 });
    console.log('[db] PostgreSQL に接続しました');
    return {
      query: (text, params) => sql.unsafe(text, params),
      close: () => sql.end(),
    };
  }
  // サーバ本体と同じ既定値（server/data）を使う
  const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(serverDir, 'data');
  const dir = path.join(dataDir, 'pglite');
  if (!fs.existsSync(dir)) {
    console.error(`データベースが見つかりません: ${dir}`);
    console.error('DATABASE_URL を設定しているサーバの場合は、その環境変数を渡して実行してください。');
    process.exit(1);
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const client = new PGlite(dir);
  console.log(`[db] PGlite を開きました（${dir}）`);
  return {
    query: async (text, params) => (await client.query(text, params)).rows,
    close: () => client.close(),
  };
}

// 入力は「届いた行を貯める」方式で読む。
// readline の question() を続けて呼ぶ形にすると、パイプで2行まとめて渡したときに
// 2問目の前に入力が終わってしまい、そこで固まる
let rl = null;
const lines = []; // まだ引き取られていない入力行
const waiting = []; // まだ行が来ていない質問

function ensureReader() {
  if (rl) return;
  rl = process.stdin.isTTY
    ? readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    : readline.createInterface({ input: process.stdin });
  rl._writeToOutput = () => {}; // 打った文字を画面に出さない
  rl.on('line', (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else lines.push(line);
  });
  // 入力が尽きたときは空文字で返す。あとの検査で弾かれるので、固まるよりよい
  rl.on('close', () => {
    while (waiting.length > 0) waiting.shift()('');
  });
}

/** 入力を画面に出さずに1行読む。パイプ経由でもそのまま受け取れる */
function askHidden(question) {
  ensureReader();
  if (process.stdin.isTTY) process.stdout.write(question);
  return new Promise((resolve) => {
    const done = (line) => {
      if (process.stdin.isTTY) process.stdout.write('\n');
      resolve(line);
    };
    const buffered = lines.shift();
    if (buffered !== undefined) done(buffered);
    else waiting.push(done);
  });
}

const db = await connect();
try {
  if (listOnly) {
    const rows = await db.query('select login_id, name, created_at from teachers order by created_at');
    if (rows.length === 0) {
      console.log('登録されている先生はいません。');
    } else {
      console.log(`\n登録されている先生（${rows.length}人）`);
      for (const r of rows) {
        console.log(`  ${String(r.login_id).padEnd(20)} ${r.name}`);
      }
    }
    process.exit(0);
  }

  const [teacher] = await db.query('select id, login_id, name from teachers where login_id = $1', [loginId]);
  if (!teacher) {
    console.error(`ログインID「${loginId}」の先生は見つかりませんでした。`);
    console.error('登録されているIDは --list で確認できます。');
    process.exit(1);
  }

  console.log(`\n対象: ${teacher.login_id}（${teacher.name}）`);
  const password = await askHidden('新しいパスワード（8文字以上・画面には出ません）: ');
  if (password.length < 8) {
    console.error('パスワードは8文字以上にしてください。変更していません。');
    process.exit(1);
  }
  const again = await askHidden('もう一度: ');
  if (password !== again) {
    console.error('2回目の入力が一致しませんでした。変更していません。');
    process.exit(1);
  }

  // 登録時と同じ強度でハッシュ化する（server/src/auth.ts の hashPassword と揃える）
  const hash = await bcrypt.hash(password, 10);
  await db.query('update teachers set password_hash = $1 where id = $2', [hash, teacher.id]);

  console.log('\nパスワードを変更しました。授業の記録はそのまま残っています。');
} finally {
  rl?.close();
  await db.close();
}
