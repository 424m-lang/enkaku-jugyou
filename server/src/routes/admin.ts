import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { requireAdmin } from '../auth';

/**
 * 管理者向けの一覧。
 *
 * 管理者が開けるのは、すべての先生の振り返り画面と通信記録だけで、どちらも閲覧専用。
 * ここでは開く先を選ぶための一覧を返す。授業の中身は各画面のAPIが返す
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/lessons', { preHandler: requireAdmin }, async () => {
    const rows = await db
      .select({
        id: schema.lessons.id,
        title: schema.lessons.title,
        status: schema.lessons.status,
        createdAt: schema.lessons.createdAt,
        startedAt: schema.lessons.startedAt,
        teacherId: schema.teachers.id,
        teacherName: schema.teachers.name,
        teacherLoginId: schema.teachers.loginId,
        telemetryUpdatedAt: schema.lessonTelemetry.updatedAt,
      })
      .from(schema.lessons)
      .innerJoin(schema.teachers, eq(schema.teachers.id, schema.lessons.teacherId))
      .leftJoin(schema.lessonTelemetry, eq(schema.lessonTelemetry.lessonId, schema.lessons.id))
      .orderBy(desc(schema.lessons.createdAt));
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      startedAt: r.startedAt?.toISOString() ?? null,
      teacherId: r.teacherId,
      teacherName: r.teacherName,
      teacherLoginId: r.teacherLoginId,
      hasTelemetry: r.telemetryUpdatedAt !== null,
    }));
  });
}
