import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, asc, desc, eq, ne } from 'drizzle-orm';
import type {
  ButtonClip,
  CommentClip,
  LessonStats,
  LessonTaskReview,
  PollReview,
  ReactionCounts,
  SlideStat,
  TaskReview,
} from '@shared';
import { config } from '../config';
import { db, schema } from '../db';
import { requireTeacher, teacherIdOf } from '../auth';
import { clusterReactions } from '../live/reactions';
import { loadSlides } from '../live/liveSessions';
import { loadSlideIntervals, slideAt } from '../slideTimeline';
import { transcribeRange } from '../ai/transcribe';
import { ensureFullTranscript } from '../ai/fullTranscript';
import { locateCommentTarget, summarizeLesson } from '../ai/summarize';

/** 自分の授業であることを確認して返す（振り返り系は先生専用） */
async function ownLesson(
  req: FastifyRequest,
  reply: FastifyReply,
  lessonId: string
): Promise<typeof schema.lessons.$inferSelect | null> {
  const [lesson] = await db
    .select()
    .from(schema.lessons)
    .where(and(eq(schema.lessons.id, lessonId), eq(schema.lessons.teacherId, teacherIdOf(req))));
  if (!lesson) {
    reply.code(404).send({ error: '授業が見つかりません' });
    return null;
  }
  return lesson;
}

async function reactionsWithNames(lessonId: string) {
  return db
    .select({
      id: schema.reactions.id,
      tMs: schema.reactions.tMs,
      kind: schema.reactions.kind,
      comment: schema.reactions.comment,
      participantId: schema.reactions.participantId,
      participantName: schema.participants.displayName,
    })
    .from(schema.reactions)
    .innerJoin(schema.participants, eq(schema.reactions.participantId, schema.participants.id))
    .where(eq(schema.reactions.lessonId, lessonId))
    .orderBy(asc(schema.reactions.tMs));
}

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** コメントの行（入力開始時刻つき） */
async function commentRows(lessonId: string) {
  return db
    .select({
      id: schema.reactions.id,
      tMs: schema.reactions.tMs,
      comment: schema.reactions.comment,
      slideId: schema.reactions.slideId,
      composeStartMs: schema.reactions.composeStartMs,
      participantName: schema.participants.displayName,
    })
    .from(schema.reactions)
    .innerJoin(schema.participants, eq(schema.reactions.participantId, schema.participants.id))
    .where(and(eq(schema.reactions.lessonId, lessonId), eq(schema.reactions.kind, 'comment')))
    .orderBy(asc(schema.reactions.tMs));
}

/** AI未解析のときの暫定範囲: 入力を始める少し前から（何を聞いて書き始めたかが入るように） */
function defaultCommentClipStart(composeStartMs: number): number {
  return Math.max(0, composeStartMs - config.buttonClipBeforeMs);
}

async function listCommentClips(lessonId: string): Promise<CommentClip[]> {
  const rows = await commentRows(lessonId);
  const analyzed = await db
    .select()
    .from(schema.commentClips)
    .where(eq(schema.commentClips.lessonId, lessonId));
  const byReaction = new Map(analyzed.map((a) => [a.reactionId, a]));

  return rows.map((r) => {
    const composeStartMs = r.composeStartMs ?? r.tMs;
    const a = byReaction.get(r.id);
    const start = a ? a.clipStartMs : defaultCommentClipStart(composeStartMs);
    return {
      id: r.id,
      text: r.comment ?? '',
      participantName: r.participantName,
      tMs: r.tMs,
      composeStartMs,
      slideId: r.slideId,
      clipStartMs: start,
      clipEndMs: a ? a.clipEndMs : Math.max(r.tMs, start + 45_000),
      targetText: a?.targetText ?? null,
      analyzed: !!a,
    };
  });
}

/**
 * 完了を取り消した直後にやり直した分は、誤操作とみなして完了時刻に数えない。
 * この幅より後の取り消しは、考え直して戻したものとして扱う
 */
const TASK_UNDO_WINDOW_MS = 10_000;

/**
 * task_progress は「その時点で完了しているタスクidの集合」のスナップショット。
 * 生徒ごとに時刻順へ並べ、タスクが集合へ入った時刻を完了時刻とする。
 * ただし入ってすぐ（TASK_UNDO_WINDOW_MS 以内に）外れたものは押し間違いなので捨て、
 * 次に入った時刻を採る。
 */
function taskDoneTimes(
  events: { tMs: number; actor: string; payload: unknown }[]
): Map<string, Map<string, number>> {
  const byParticipant = new Map<string, { tMs: number; taskIds: string[] }[]>();
  for (const ev of events) {
    const p = ev.payload as { participantId?: string; taskIds?: string[] } | null;
    const pid = p?.participantId ?? ev.actor;
    if (!pid || !Array.isArray(p?.taskIds)) continue;
    const list = byParticipant.get(pid) ?? [];
    list.push({ tMs: ev.tMs, taskIds: p.taskIds });
    byParticipant.set(pid, list);
  }

  const out = new Map<string, Map<string, number>>();
  for (const [pid, list] of byParticipant) {
    list.sort((a, b) => a.tMs - b.tMs);
    const done = new Map<string, number>(); // taskId → 完了とみなす時刻
    let prev = new Set<string>();
    for (const snap of list) {
      const cur = new Set(snap.taskIds);
      for (const taskId of cur) {
        if (!prev.has(taskId)) done.set(taskId, snap.tMs); // 入った
      }
      for (const taskId of prev) {
        if (cur.has(taskId)) continue; // まだ入っている
        const at = done.get(taskId);
        // 押してすぐ外したものは無かったことにする
        if (at !== undefined && snap.tMs - at <= TASK_UNDO_WINDOW_MS) done.delete(taskId);
      }
      prev = cur;
    }
    // 最後のスナップショットに残っていないタスクは、完了として数えない
    for (const taskId of [...done.keys()]) {
      if (!prev.has(taskId)) done.delete(taskId);
    }
    out.set(pid, done);
  }
  return out;
}

/** 参加者のうち required 人が完了した実際の時刻。未到達なら null */
function completionMilestone(sorted: number[], required: number): number | null {
  if (required <= 0 || sorted.length < required) return null;
  return sorted[required - 1] ?? null;
}

export async function reviewRoutes(app: FastifyInstance): Promise<void> {
  // ---- 開発・検証用: 自分が担当した授業の匿名通信集計 ----
  app.get('/api/telemetry', { preHandler: requireTeacher }, async (req) => {
    const rows = await db
      .select({
        lessonId: schema.lessons.id,
        title: schema.lessons.title,
        status: schema.lessons.status,
        createdAt: schema.lessons.createdAt,
        metrics: schema.lessonTelemetry.metrics,
        updatedAt: schema.lessonTelemetry.updatedAt,
      })
      .from(schema.lessons)
      .leftJoin(schema.lessonTelemetry, eq(schema.lessonTelemetry.lessonId, schema.lessons.id))
      .where(eq(schema.lessons.teacherId, teacherIdOf(req)))
      .orderBy(desc(schema.lessons.createdAt));
    return rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt?.toISOString() ?? null,
    }));
  });

  // ---- 「アンケート」タブ: 締め切り後の確定した集計 ----
  app.get('/api/lessons/:id/poll-review', { preHandler: requireTeacher }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const lesson = await ownLesson(req, reply, id);
    if (!lesson) return;

    const [polls, answers, parts] = await Promise.all([
      db
        .select()
        .from(schema.polls)
        .where(eq(schema.polls.lessonId, id))
        .orderBy(asc(schema.polls.position)),
      db
        .select({
          pollId: schema.pollAnswers.pollId,
          optionIds: schema.pollAnswers.optionIds,
          text: schema.pollAnswers.text,
          answeredAtMs: schema.pollAnswers.answeredAtMs,
          participantName: schema.participants.displayName,
        })
        .from(schema.pollAnswers)
        .innerJoin(
          schema.participants,
          eq(schema.participants.id, schema.pollAnswers.participantId)
        )
        .where(eq(schema.pollAnswers.lessonId, id)),
      db
        .select({ joinedAt: schema.participants.joinedAt })
        .from(schema.participants)
        .where(eq(schema.participants.lessonId, id)),
    ]);

    // 「もう一度聞く」は同じ質問で別の設問を作る。何回目かを出すために質問文でまとめる
    const rounds = new Map<string, number>();
    for (const p of polls) rounds.set(p.question, (rounds.get(p.question) ?? 0) + 1);
    const seen = new Map<string, number>();

    const list: PollReview[] = polls.map((p) => {
      const round = (seen.get(p.question) ?? 0) + 1;
      seen.set(p.question, round);

      const mine = answers.filter((a) => a.pollId === p.id);
      const cutoffEpochMs =
        lesson.startedAt && p.closedAtMs !== null
          ? lesson.startedAt.getTime() + p.closedAtMs
          : Number.POSITIVE_INFINITY;
      const eligibleCount = parts.filter((participant) =>
        participant.joinedAt.getTime() <= cutoffEpochMs
      ).length;
      const counts: Record<string, number> = {};
      for (const o of p.options) counts[o.id] = 0;
      for (const a of mine) {
        for (const oid of a.optionIds) counts[oid] = (counts[oid] ?? 0) + 1;
      }
      return {
        pollId: p.id,
        question: p.question,
        type: p.type,
        options: p.options,
        minLabel: p.minLabel,
        maxLabel: p.maxLabel,
        openedAtMs: p.openedAtMs,
        closedAtMs: p.closedAtMs,
        counts,
        answered: mine.length,
        total: eligibleCount,
        texts: mine
          .filter((a) => a.text)
          .map((a) => ({
            participantName: a.participantName,
            text: a.text as string,
            answeredAtMs: a.answeredAtMs,
          }))
          .sort((x, y) => x.answeredAtMs - y.answeredAtMs),
        round,
        roundCount: rounds.get(p.question) ?? 1,
      };
    });
    return { polls: list };
  });

  // ---- 「タスク」タブ: どのタスクまで、いつ、何人が進んだか ----
  app.get('/api/lessons/:id/task-review', { preHandler: requireTeacher }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const lesson = await ownLesson(req, reply, id);
    if (!lesson) return;

    const [events, parts] = await Promise.all([
      db
        .select({
          tMs: schema.timelineEvents.tMs,
          actor: schema.timelineEvents.actor,
          payload: schema.timelineEvents.payload,
        })
        .from(schema.timelineEvents)
        .where(
          and(
            eq(schema.timelineEvents.lessonId, id),
            eq(schema.timelineEvents.type, 'task_progress')
          )
        )
        .orderBy(asc(schema.timelineEvents.tMs)),
      db.select().from(schema.participants).where(eq(schema.participants.lessonId, id)),
    ]);

    const doneTimes = taskDoneTimes(events);
    const tasks: TaskReview[] = lesson.tasks.map((t) => {
      const times: number[] = [];
      for (const done of doneTimes.values()) {
        const at = done.get(t.id);
        if (at !== undefined) times.push(at);
      }
      times.sort((a, b) => a - b);
      const halfway = Math.ceil(parts.length / 2);
      return {
        taskId: t.id,
        label: t.label,
        addedAtMs: t.addedAtMs,
        done: times.length,
        total: parts.length,
        firstDoneMs: times[0] ?? null,
        halfDoneMs: completionMilestone(times, halfway),
        allDoneMs: completionMilestone(times, parts.length),
      };
    });

    const allDone = lesson.tasks.length
      ? [...doneTimes.values()].filter((d) => lesson.tasks.every((t) => d.has(t.id))).length
      : 0;

    const review: LessonTaskReview = {
      mode: lesson.taskMode,
      tasks,
      allDone,
      total: parts.length,
    };
    return review;
  });

  // ---- タイムライン全イベント（同期再生用） ----
  app.get('/api/lessons/:id/timeline', { preHandler: requireTeacher }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const lesson = await ownLesson(req, reply, id);
    if (!lesson) return;
    const events = await db
      .select({
        id: schema.timelineEvents.id,
        tMs: schema.timelineEvents.tMs,
        type: schema.timelineEvents.type,
        payload: schema.timelineEvents.payload,
      })
      .from(schema.timelineEvents)
      .where(eq(schema.timelineEvents.lessonId, id))
      .orderBy(asc(schema.timelineEvents.tMs));
    return { durationMs: lesson.audioDurationMs ?? 0, events };
  });

  // ---- 「ボタン」タブ: ボタン反応のクリップ（反応の30秒前〜15秒後、同じ事柄はまとめる） ----
  app.get('/api/lessons/:id/button-clips', { preHandler: requireTeacher }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const lesson = await ownLesson(req, reply, id);
    if (!lesson) return;

    const rows = await db
      .select({
        id: schema.reactions.id,
        tMs: schema.reactions.tMs,
        kind: schema.reactions.kind,
        slideId: schema.reactions.slideId,
        participantId: schema.reactions.participantId,
        participantName: schema.participants.displayName,
      })
      .from(schema.reactions)
      .innerJoin(schema.participants, eq(schema.reactions.participantId, schema.participants.id))
      .where(and(eq(schema.reactions.lessonId, id), ne(schema.reactions.kind, 'comment')))
      .orderBy(asc(schema.reactions.tMs));

    // 時間が近く、同じスライドへの反応は「同じ事柄への反応」とみなしてひとまとめにする
    const groups: (typeof rows)[] = [];
    for (const r of rows) {
      const g = groups[groups.length - 1];
      const prev = g?.[g.length - 1];
      const sameTopic =
        prev !== undefined &&
        r.tMs - prev.tMs <= config.buttonMergeGapMs &&
        // スライドが分かる場合は同じスライドのときだけまとめる（旧データはnullなので時間のみ）
        (r.slideId === null || prev.slideId === null || r.slideId === prev.slideId);
      if (sameTopic) g.push(r);
      else groups.push([r]);
    }

    const clips: ButtonClip[] = groups.map((g) => {
      const kinds: ReactionCounts = {};
      const participantIds = new Set<string>();
      for (const r of g) {
        kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
        participantIds.add(r.participantId);
      }
      return {
        id: g[0].id,
        startMs: Math.max(0, g[0].tMs - config.buttonClipBeforeMs),
        endMs: g[g.length - 1].tMs + config.buttonClipAfterMs,
        kinds,
        participantCount: participantIds.size,
        reactions: g.map((r) => ({ name: r.participantName, kind: r.kind, tMs: r.tMs })),
        slideId: g[0].slideId,
      };
    });
    return clips;
  });

  // ---- 「コメント」タブ: コメントごとのクリップ（AI解析済みならその位置、未解析は暫定範囲） ----
  app.get('/api/lessons/:id/comment-clips', { preHandler: requireTeacher }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const lesson = await ownLesson(req, reply, id);
    if (!lesson) return;
    return listCommentClips(id);
  });

  // ---- 「コメント」タブ: コメントが向けられた発言をAIで特定してクリップ位置を決める ----
  app.post('/api/lessons/:id/comment-clips/analyze', { preHandler: requireTeacher }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const lesson = await ownLesson(req, reply, id);
    if (!lesson) return;

    const comments = await commentRows(id);
    const done = await db
      .select({ reactionId: schema.commentClips.reactionId })
      .from(schema.commentClips)
      .where(eq(schema.commentClips.lessonId, id));
    const doneIds = new Set(done.map((d) => d.reactionId));

    // 授業全体の文字起こしを一度だけ用意する。
    // 授業中に貯めた分（scope='clip'）を組み合わせ、足りない範囲だけを追加で起こす。
    //
    // 以前はコメント1件ごとに「手前4分」を起こし直していた。
    // その範囲は授業中にすでに起こしてあるので、**同じ音声をもう一度Whisperへ送っていた**。
    // コメントが10件あれば最大40分の音声について、費用も待ち時間も余分にかかっていた
    const durationMs = lesson.audioDurationMs ?? 0;
    const allSegments = durationMs > 0 ? await ensureFullTranscript(id, durationMs) : [];

    for (const c of comments) {
      if (doneIds.has(c.id) || !c.comment) continue;
      const composeStart = c.composeStartMs ?? c.tMs;
      // コメントの手前（入力開始の数分前〜送信時刻）から、対象の発言を探す
      const from = Math.max(0, composeStart - config.commentLookbackMs);
      const segments = allSegments.filter((seg) => seg.endMs > from && seg.startMs < c.tMs);
      let clipStartMs = defaultCommentClipStart(composeStart);
      let clipEndMs = Math.max(c.tMs, clipStartMs + 45_000);
      let targetText: string | null = null;

      if (segments.length > 0) {
        const idx = await locateCommentTarget(segments, c.comment);
        if (idx !== null) {
          const seg = segments[idx];
          targetText = seg.text.trim();
          // 特定した発言の少し前から、そのあと生徒が理解を確かめられる程度まで
          clipStartMs = Math.max(0, seg.startMs - 10_000);
          clipEndMs = Math.max(seg.endMs + 20_000, clipStartMs + 30_000);
        }
      }

      await db.insert(schema.commentClips).values({
        id: crypto.randomUUID(),
        lessonId: id,
        reactionId: c.id,
        clipStartMs,
        clipEndMs,
        targetText,
      });
    }
    return listCommentClips(id);
  });

  // ---- 「スライド」タブ: スライドごとの表示時間・所属ブロック・反応数 ----
  // コメントとボタン反応を「最も関連するであろうスライド」へ振り分けて集計する。
  // コメントはAIが対象の発言を特定済みならその時刻のスライド、未解析なら入力開始時のスライド。
  app.get('/api/lessons/:id/slide-stats', { preHandler: requireTeacher }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const lesson = await ownLesson(req, reply, id);
    if (!lesson) return;

    const durationMs = lesson.audioDurationMs ?? 0;
    const slides = await loadSlides(id);
    const intervals = await loadSlideIntervals(id, durationMs);
    const chapters = await db
      .select({ id: schema.reviewChapters.id, slideIds: schema.reviewChapters.slideIds })
      .from(schema.reviewChapters)
      .where(eq(schema.reviewChapters.lessonId, id));
    const reactions = await db
      .select({
        tMs: schema.reactions.tMs,
        kind: schema.reactions.kind,
        slideId: schema.reactions.slideId,
      })
      .from(schema.reactions)
      .where(eq(schema.reactions.lessonId, id));
    const clips = await db
      .select({
        reactionId: schema.commentClips.reactionId,
        clipStartMs: schema.commentClips.clipStartMs,
        clipEndMs: schema.commentClips.clipEndMs,
      })
      .from(schema.commentClips)
      .where(eq(schema.commentClips.lessonId, id));
    const commentRowsForSlide = await db
      .select({ id: schema.reactions.id, tMs: schema.reactions.tMs, slideId: schema.reactions.slideId })
      .from(schema.reactions)
      .where(and(eq(schema.reactions.lessonId, id), eq(schema.reactions.kind, 'comment')));
    const clipByReaction = new Map(clips.map((c) => [c.reactionId, c]));

    const stats = new Map<string, SlideStat>();
    slides.forEach((s, i) => {
      stats.set(s.id, {
        slideId: s.id,
        slideNo: i + 1,
        kind: s.kind,
        pdfPageIndex: s.pdfPageIndex,
        shownMs: 0,
        showCount: 0,
        firstShownMs: null,
        chapterIds: [],
        commentCount: 0,
        buttonCount: 0,
        kinds: {},
      });
    });

    for (const iv of intervals) {
      const st = stats.get(iv.slideId);
      if (!st) continue;
      st.shownMs += iv.endMs - iv.startMs;
      st.showCount += 1;
      if (st.firstShownMs === null) st.firstShownMs = iv.startMs;
    }
    for (const ch of chapters) {
      for (const slideId of ch.slideIds ?? []) stats.get(slideId)?.chapterIds.push(ch.id);
    }

    // ボタン反応: 記録されたスライド、無ければ押された時刻に映していたスライド
    for (const r of reactions) {
      if (r.kind === 'comment') continue;
      const slideId = r.slideId ?? slideAt(intervals, r.tMs);
      const st = slideId ? stats.get(slideId) : undefined;
      if (!st) continue;
      st.buttonCount += 1;
      st.kinds[r.kind] = (st.kinds[r.kind] ?? 0) + 1;
    }
    // コメント: AIが特定した対象発言の位置を優先する
    for (const c of commentRowsForSlide) {
      const clip = clipByReaction.get(c.id);
      const at = clip ? Math.min(clip.clipStartMs + 10_000, clip.clipEndMs) : null;
      const slideId = (at !== null ? slideAt(intervals, at) : null) ?? c.slideId ?? slideAt(intervals, c.tMs);
      const st = slideId ? stats.get(slideId) : undefined;
      if (!st) continue;
      st.commentCount += 1;
    }

    return [...stats.values()];
  });

  // ---- クリップ一覧（反応クラスタ + 既存の文字起こし/提案） ----
  app.get('/api/lessons/:id/clips', { preHandler: requireTeacher }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const lesson = await ownLesson(req, reply, id);
    if (!lesson) return;

    const rows = await reactionsWithNames(id);
    const clusters = clusterReactions(rows);

    // 授業中に生成済みのクリップ文字起こし・提案を範囲の重なりで対応付け
    const clipTranscripts = await db
      .select()
      .from(schema.transcripts)
      .where(and(eq(schema.transcripts.lessonId, id), eq(schema.transcripts.scope, 'clip')));
    for (const c of clusters) {
      const t = clipTranscripts.find(
        (row) => row.rangeStartMs < c.endMs && row.rangeEndMs > c.startMs
      );
      if (t) {
        c.transcriptText = t.text;
        c.summaryText = t.summary;
      }
    }
    return clusters;
  });

  // ---- クリップ範囲のオンデマンド文字起こし ----
  app.post('/api/lessons/:id/clips/transcribe', { preHandler: requireTeacher }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const lesson = await ownLesson(req, reply, id);
    if (!lesson) return;
    const { startMs, endMs } = (req.body ?? {}) as { startMs?: number; endMs?: number };
    if (typeof startMs !== 'number' || typeof endMs !== 'number' || endMs <= startMs) {
      return reply.code(400).send({ error: '範囲が不正です' });
    }
    const t = await transcribeRange(id, startMs, endMs);
    if (!t) return reply.code(404).send({ error: '対象範囲の音声がありません' });
    await db.insert(schema.transcripts).values({
      id: crypto.randomUUID(),
      lessonId: id,
      scope: 'clip',
      rangeStartMs: startMs,
      rangeEndMs: endMs,
      text: t.text,
      segments: t.segments,
      provider: t.provider,
    });
    return { text: t.text };
  });

  // ---- 授業全体の文字起こし + AI要約 ----
  app.post('/api/lessons/:id/summarize', { preHandler: requireTeacher }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const lesson = await ownLesson(req, reply, id);
    if (!lesson) return;
    if (lesson.status !== 'ended') {
      return reply.code(409).send({ error: '授業終了後に実行できます' });
    }
    const durationMs = lesson.audioDurationMs ?? 0;
    if (durationMs <= 0) return reply.code(409).send({ error: '録音がありません' });

    // 授業中に貯めた文字起こしを組み合わせ、足りない範囲だけを追加で起こす。
    // ここで毎回 0〜終わり を起こし直していたころは、「AI要約」を押すたびに
    // **授業1コマ分の文字起こし料金がもう一度**かかっていた
    const segments = await ensureFullTranscript(id, durationMs);
    if (segments.length === 0) {
      return reply.code(409).send({ error: '録音ファイルが見つかりません' });
    }
    const text = segments.map((s) => s.text).join('');
    const [fullRow] = await db
      .select({ provider: schema.transcripts.provider })
      .from(schema.transcripts)
      .where(and(eq(schema.transcripts.lessonId, id), eq(schema.transcripts.scope, 'full')));
    const provider = fullRow?.provider ?? config.transcribeProvider;

    const rows = await reactionsWithNames(id);
    const clusters = clusterReactions(rows).slice(0, 8);
    const clusterNotes = clusters.map((c) => {
      const kinds = Object.entries(c.kinds)
        .map(([k, n]) => `${k}×${n}`)
        .join(', ');
      const comments = c.participants
        .map((p) => p.comment)
        .filter(Boolean)
        .slice(0, 3)
        .join(' / ');
      return `${fmtMs(c.centerMs)}頃: ${c.participantCount}人が反応（${kinds}）${comments ? ` コメント: ${comments}` : ''}`;
    });

    const summary = await summarizeLesson(text, clusterNotes);

    // 既存の全体要約は置き換える
    await db
      .delete(schema.transcripts)
      .where(and(eq(schema.transcripts.lessonId, id), eq(schema.transcripts.scope, 'full')));
    await db.insert(schema.transcripts).values({
      id: crypto.randomUUID(),
      lessonId: id,
      scope: 'full',
      rangeStartMs: 0,
      rangeEndMs: durationMs,
      text,
      summary: summary.text,
      segments,
      provider,
      model: summary.provider,
    });

    return {
      text,
      summary: summary.text,
      segments,
      provider,
      model: summary.provider,
      createdAt: new Date().toISOString(),
    };
  });

  // ---- 保存済みの全体要約を取得 ----
  app.get('/api/lessons/:id/summary', { preHandler: requireTeacher }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const lesson = await ownLesson(req, reply, id);
    if (!lesson) return;
    const [row] = await db
      .select()
      .from(schema.transcripts)
      .where(and(eq(schema.transcripts.lessonId, id), eq(schema.transcripts.scope, 'full')))
      .orderBy(desc(schema.transcripts.createdAt))
      .limit(1);
    if (!row) return reply.code(404).send({ error: 'まだ要約がありません' });
    return {
      text: row.text,
      summary: row.summary,
      segments: row.segments,
      provider: row.provider,
      model: row.model,
      createdAt: row.createdAt.toISOString(),
    };
  });

  // ---- 統計ダッシュボード ----
  app.get('/api/lessons/:id/stats', { preHandler: requireTeacher }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const lesson = await ownLesson(req, reply, id);
    if (!lesson) return;

    const parts = await db
      .select()
      .from(schema.participants)
      .where(eq(schema.participants.lessonId, id));
    const rows = await reactionsWithNames(id);

    const countsByKind: ReactionCounts = {};
    const byMinute = new Map<number, ReactionCounts>();
    const byParticipant = new Map<
      string,
      { name: string; counts: ReactionCounts; reactions: { tMs: number; kind: string; comment: string | null }[] }
    >();

    for (const p of parts) {
      byParticipant.set(p.id, { name: p.displayName, counts: {}, reactions: [] });
    }
    for (const r of rows) {
      countsByKind[r.kind] = (countsByKind[r.kind] ?? 0) + 1;
      const minute = Math.floor(r.tMs / 60_000);
      const m = byMinute.get(minute) ?? {};
      m[r.kind] = (m[r.kind] ?? 0) + 1;
      byMinute.set(minute, m);
      const bp = byParticipant.get(r.participantId);
      if (bp) {
        bp.counts[r.kind] = (bp.counts[r.kind] ?? 0) + 1;
        bp.reactions.push({ tMs: r.tMs, kind: r.kind, comment: r.comment });
      }
    }

    const durationMin = Math.ceil((lesson.audioDurationMs ?? 0) / 60_000);
    const timeline: LessonStats['timeline'] = [];
    for (let minute = 0; minute < Math.max(durationMin, byMinute.size > 0 ? Math.max(...byMinute.keys()) + 1 : 0); minute++) {
      const counts = byMinute.get(minute) ?? {};
      timeline.push({
        minute,
        counts,
        total: Object.values(counts).reduce((a, b) => a + b, 0),
      });
    }

    const stats: LessonStats = {
      totalParticipants: parts.length,
      totalReactions: rows.length,
      countsByKind,
      timeline,
      perParticipant: [...byParticipant.entries()]
        .map(([participantId, v]) => ({
          participantId,
          name: v.name,
          total: v.reactions.length,
          counts: v.counts,
          reactions: v.reactions,
        }))
        .sort((a, b) => b.total - a.total),
    };
    return stats;
  });
}
