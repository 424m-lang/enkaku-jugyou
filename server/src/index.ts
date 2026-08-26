import path from 'node:path';
import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@shared';
import { config } from './config';
import { initDb } from './db';
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
