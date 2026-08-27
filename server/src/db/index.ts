import path from 'node:path';
import fs from 'node:fs';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { config } from '../config';
import * as schema from './schema';

export type Db = PostgresJsDatabase<typeof schema>;

export let db: Db;

/**
 * 接続の閉じ方。終了時に closeDb() から呼ぶ。
 * PGlite（ローカル運用）は開いたままプロセスが落ちると、
 * 次に開けなくなることがあるので、必ず閉じてから終わる。
 */
let closeClient: (() => Promise<void>) | null = null;

export async function initDb(): Promise<void> {
  const migrationsFolder = path.join(import.meta.dirname, '..', '..', 'drizzle');

  if (config.databaseUrl) {
    const { drizzle } = await import('drizzle-orm/postgres-js');
    const { migrate } = await import('drizzle-orm/postgres-js/migrator');
    const postgres = (await import('postgres')).default;
    const client = postgres(config.databaseUrl, { max: 10 });
    const d = drizzle(client, { schema });
    await migrate(d, { migrationsFolder });
    db = d;
    closeClient = () => client.end({ timeout: 5 });
    console.log('[db] PostgreSQL に接続しました');
  } else {
    // ローカル開発用: ファイルベースのPostgres互換DB（PGlite）
    fs.mkdirSync(config.dataDir, { recursive: true });
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    const client = new PGlite(path.join(config.dataDir, 'pglite'));
    const d = drizzle(client, { schema });
    await migrate(d, { migrationsFolder });
    db = d as unknown as Db;
    closeClient = () => client.close();
    console.log('[db] PGlite（ローカルファイルDB）で起動しました。本番では DATABASE_URL を設定してください');
  }
}

/** 終了時にDBを閉じる。2回呼んでも安全 */
export async function closeDb(): Promise<void> {
  const close = closeClient;
  closeClient = null;
  if (close) await close();
}

export { schema };
