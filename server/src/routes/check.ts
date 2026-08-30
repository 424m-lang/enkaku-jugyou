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

const FALLBACK_USD_JPY = 155;
const FX_CACHE_MS = 12 * 60 * 60 * 1000;

/** 外部料金ページは実行時に解析せず、確認日と単価を組にして更新する */
const COST_RATES = {
  asOf: '2026-08-30',
  render: {
    serverMonthlyUsd: 7,
    diskMonthlyUsd: 0.75,
    includedOutboundGb: 5,
    outboundPerGbUsd: 0.15,
  },
  openai: {
    whisperPerMinuteUsd: 0.006,
    lunaInputPerMillionUsd: 0.2,
    lunaOutputPerMillionUsd: 1.2,
  },
} as const;

type FxRate = {
  usdJpy: number;
  roundedUsdJpy: number;
  source: 'boj' | 'fallback';
  rateDate: string | null;
};

let fxCache: { expiresAt: number; value: FxRate } | null = null;

function yyyymm(date: Date): string {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function yyyymmdd(value: number): string {
  const text = String(value);
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

async function loadUsdJpy(): Promise<FxRate> {
  if (fxCache && fxCache.expiresAt > Date.now()) return fxCache.value;
  try {
    const now = new Date();
    const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const params = new URLSearchParams({
      format: 'json',
      lang: 'en',
      db: 'FM08',
      code: 'FXERD04',
      startDate: yyyymm(previous),
      endDate: yyyymm(now),
    });
    const response = await fetch(
      `https://www.stat-search.boj.or.jp/api/v1/getDataCode?${params}`,
      { signal: AbortSignal.timeout(8_000) }
    );
    if (!response.ok) throw new Error(`BOJ API ${response.status}`);
    const body = (await response.json()) as {
      STATUS?: number;
      RESULTSET?: { VALUES?: { SURVEY_DATES?: number[]; VALUES?: (number | null)[] } }[];
    };
    if (body.STATUS !== 200) throw new Error(`BOJ API status ${body.STATUS ?? 'unknown'}`);
    const dates = body.RESULTSET?.[0]?.VALUES?.SURVEY_DATES ?? [];
    const values = body.RESULTSET?.[0]?.VALUES?.VALUES ?? [];
    let latest: { date: number; value: number } | null = null;
    for (let i = 0; i < Math.min(dates.length, values.length); i++) {
      const value = values[i];
      if (typeof value === 'number' && Number.isFinite(value)) {
        latest = { date: dates[i], value };
      }
    }
    if (!latest) throw new Error('BOJ API returned no rate');
    const value: FxRate = {
      usdJpy: latest.value,
      roundedUsdJpy: Math.round(latest.value / 5) * 5,
      source: 'boj',
      rateDate: yyyymmdd(latest.date),
    };
    fxCache = { expiresAt: Date.now() + FX_CACHE_MS, value };
    return value;
  } catch (error) {
    appLogFxError(error);
    const value: FxRate = {
      usdJpy: FALLBACK_USD_JPY,
      roundedUsdJpy: FALLBACK_USD_JPY,
      source: 'fallback',
      rateDate: null,
    };
    // 障害から早く復帰できるよう、代替値のキャッシュは1時間にする。
    fxCache = { expiresAt: Date.now() + 60 * 60 * 1000, value };
    return value;
  }
}

function appLogFxError(error: unknown): void {
  console.warn('[cost-rates] 日本銀行の為替を取得できないため、代替値を使用します', error);
}

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

  app.get('/api/check/cost-rates', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=3600');
    return { fx: await loadUsdJpy(), rates: COST_RATES };
  });
}
