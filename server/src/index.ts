import path from 'node:path';
import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@shared';
import { config } from './config';
import { initDb, closeDb } from './db';
import { flushAllSessions } from './live/liveSessions';
import { authRoutes } from './routes/auth';
import { joinRoutes } from './routes/join';
import { lessonRoutes } from './routes/lessons';
import { reviewRoutes } from './routes/review';
import { reviewVideoRoutes } from './routes/reviewVideo';
import { setupRealtime, type TypedServer } from './realtime';

async function main() {
  await initDb();
  fs.mkdirSync(config.dataDir, { recursive: true });

  const app = Fastify({ logger: { level: 'info' } });

  await app.register(fastifyCookie, { secret: config.sessionSecret });
  await app.register(fastifyMultipart, {
    limits: { fileSize: 100 * 1024 * 1024 }, // PDF最大100MB
  });

  app.get('/api/health', async () => ({ ok: true, time: new Date().toISOString() }));

  await app.register(authRoutes);
  await app.register(joinRoutes);
  await app.register(lessonRoutes);
  await app.register(reviewRoutes);
  await app.register(reviewVideoRoutes);

  // 本番: ビルド済みクライアントを配信（SPAフォールバック付き）
  const clientDist = path.join(import.meta.dirname, '..', '..', 'client', 'dist');
  if (fs.existsSync(clientDist)) {
    await app.register(fastifyStatic, { root: clientDist });
    app.setNotFoundHandler((req, reply) => {
      const url = (req.raw.url ?? '').split('?')[0];
      if (url.startsWith('/api')) {
        reply.code(404).send({ error: 'Not Found' });
        return;
      }
      // 拡張子の付いたURL（= ファイルを取りに来た要求）は、素直に404を返す。
      // ここで index.html を200で返すと、入れ替えで消えたJSの要求にHTMLが返り、
      // ブラウザ側は「JSのはずがHTMLだった」という分かりにくい失敗になる。
      // 画面のURLには拡張子が付かない（授業IDはUUID、公開トークンはbase64url）ので、
      // この判定でSPAのルートを取りこぼすことはない
      if (/\.[a-zA-Z0-9]+$/.test(url)) {
        reply.code(404).send({ error: 'Not Found' });
        return;
      }
      reply.sendFile('index.html');
    });
  }

  const io: TypedServer = new Server<ClientToServerEvents, ServerToClientEvents>(app.server, {
    maxHttpBufferSize: 5 * 1024 * 1024,
    cors: config.isProd ? undefined : { origin: true, credentials: true },
  });

  setupRealtime(app, io);

  await app.listen({ port: config.port, host: config.host });
  console.log(`[server] http://localhost:${config.port} で起動しました`);

  // ---- 終了処理 ----
  // Ctrl+C や、コンソールのウィンドウを閉じたとき（Windows では SIGHUP）に、
  // 録音のファイルとDBを閉じてから終わる。ローカル運用のDBは PGlite で、
  // 開いたままプロセスが落ちると次に開けなくなることがある。
  //
  // Windows はウィンドウを閉じてから約10秒で問答無用に終了させるので、
  // こちらは8秒で切り上げる。
  let shuttingDown = false;
  async function shutdown(reason: string, exitCode = 0): Promise<void> {
    if (shuttingDown) {
      // 2回目は待たない（1回目が固まったときのため）
      console.log(`[server] ${reason} をもう一度受け取りました。すぐに終了します`);
      process.exit(1);
    }
    shuttingDown = true;
    console.log(`[server] ${reason} を受け取りました。終了処理をしています…`);
    const giveUp = setTimeout(() => {
      console.error('[server] 終了処理が8秒で終わりませんでした。そのまま終了します');
      process.exit(1);
    }, 8_000);
    giveUp.unref?.();
    try {
      // つないだままの生徒・先生を切る。切らないとHTTPサーバが閉じ切らない
      io.disconnectSockets(true);
      await app.close();
      await flushAllSessions();
      // DBは最後。ここまでの書き込みが終わってから閉じる
      await closeDb();
      console.log('[server] 終了しました');
      process.exit(exitCode);
    } catch (err) {
      console.error('[server] 終了処理に失敗しました', err);
      process.exit(1);
    }
  }

  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  if (process.platform === 'win32') signals.push('SIGBREAK');
  for (const signal of signals) process.on(signal, () => void shutdown(signal));

  // 想定外のエラーで落ちるときも、**DBだけは閉じてから**終わる。
  // Node の既定はそのまま異常終了で、それだとローカル運用のDBが開いたまま残る。
  // ここで拾っても状態は壊れている可能性があるので、続行はせずに終了する。
  process.on('uncaughtException', (err) => {
    console.error('[server] 想定外のエラーが起きました', err);
    void shutdown('想定外のエラー', 1);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[server] 拾われなかった Promise の失敗が起きました', reason);
    void shutdown('Promise の失敗', 1);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
