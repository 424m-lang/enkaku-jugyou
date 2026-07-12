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

  // 本番: ビルド済みクライアントを配信（SPAフォールバック付き）
  const clientDist = path.join(import.meta.dirname, '..', '..', 'client', 'dist');
  if (fs.existsSync(clientDist)) {
    await app.register(fastifyStatic, { root: clientDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith('/api')) {
        reply.code(404).send({ error: 'Not Found' });
      } else {
        reply.sendFile('index.html');
      }
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
