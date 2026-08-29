import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

/**
 * 約128kbpsの回線では8秒ほどかかる大きさ。
 * 小さすぎると往復時間の影響が大きく、速度制限の一時的なバーストだけで
 * 実際より速く見えるため、端末チェックに必要な範囲で長めに流す。
 */
const SPEED_TEST_BYTES = 128 * 1024;
// 中継サービスで圧縮されても測定量が変わらないよう、圧縮しにくい内容を起動時に1回作る。
const DOWNLOAD_PAYLOAD = randomBytes(SPEED_TEST_BYTES);

export async function checkRoutes(app: FastifyInstance): Promise<void> {
  // このプラグイン内の測定用POSTだけで使用する。授業のAPIのbody解析には影響させない。
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: SPEED_TEST_BYTES + 1024 },
    (_req, body, done) => done(null, body)
  );

  app.get('/api/check/download', async (_req, reply) => {
    reply
      .header('Content-Type', 'application/octet-stream')
      .header('Cache-Control', 'no-store, max-age=0')
      .header('Content-Length', String(DOWNLOAD_PAYLOAD.byteLength));
    return reply.send(DOWNLOAD_PAYLOAD);
  });

  app.post('/api/check/upload', async (req, reply) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.byteLength === 0) {
      reply.code(400);
      return { error: '測定データがありません' };
    }
    return { receivedBytes: body.byteLength };
  });
}
