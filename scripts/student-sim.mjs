// 生徒シミュレータ（開発・デモ用）
// 使い方: node scripts/student-sim.mjs <授業コード> [表示名] [リアクションkind] [遅延ms]
//   例: node scripts/student-sim.mjs QNE4NG 生徒A confused 3000
// サーバから届くイベントを標準出力にログします。
import { io } from 'socket.io-client';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const [code, name = '生徒A', reactionKind, delayStr] = process.argv.slice(2);

if (!code) {
  console.error('授業コードを指定してください');
  process.exit(1);
}

const res = await fetch(`${BASE}/api/join`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code, displayName: name }),
});
const data = await res.json();
if (!res.ok) {
  console.error('参加失敗:', data);
  process.exit(1);
}
const { participantToken, lesson } = data;
console.log(`[sim:${name}] joined lesson=${lesson.id} title=${lesson.title}`);

const socket = io(BASE, {
  auth: { lessonId: lesson.id, participantToken },
});

socket.on('connect', () => console.log(`[sim:${name}] connected`));
socket.on('disconnect', (r) => console.log(`[sim:${name}] disconnected: ${r}`));
socket.onAny((ev, ...args) => {
  if (ev === 'audio_chunk' || ev === 'audio_init') {
    const buf = args[0];
    const size = buf?.byteLength ?? buf?.length ?? 0;
    console.log(`[sim:${name}] EV ${ev} bytes=${size} seq=${args[1]}`);
    return;
  }
  console.log(`[sim:${name}] EV ${ev} ${JSON.stringify(args).slice(0, 240)}`);
});

if (reactionKind) {
  setTimeout(() => {
    socket.emit('reaction', { kind: reactionKind, delayMs: 0 }, (r) =>
      console.log(`[sim:${name}] reaction ack:`, JSON.stringify(r))
    );
  }, Number(delayStr ?? 3000));
}
