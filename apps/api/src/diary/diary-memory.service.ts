import {
  and,
  asc,
  desc,
  eq,
  gte,
  lte,
  inArray,
  isNotNull,
  diaryAiPolicies,
  diaryAiGrants,
  diaryAiTurnReferences,
  diaryNotebooks,
  diaryPages,
  aiTurns,
  users,
} from '@mental-health/database';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AIProviderError, ConflictError, NotFoundError } from '../common/errors';
import { DatabaseService } from '../database/database.service';
import { AuditLogRepository } from '../safety/audit/audit-log.repository';
import { diaryContentSchema } from './diary.schemas';
import {
  diaryFingerprint,
  diaryWindow,
  selectDiaryEntries,
  type DiaryMemoryBundle,
} from './diary-memory.policy';

export const diaryAccessSchema = z
  .object({
    mode: z.enum(['none', 'selected', 'all']),
    notebookIds: z
      .array(z.uuid())
      .max(50)
      .refine((ids) => ids.length === new Set(ids).size),
    expectedRevision: z.int().min(0),
  })
  .strict()
  .refine(
    (value) =>
      value.mode === 'selected' ? value.notebookIds.length > 0 : value.notebookIds.length === 0,
    '请选择日记本，或切换为完全不允许',
  );
export type DiaryAccessInput = z.infer<typeof diaryAccessSchema>;

@Injectable()
export class DiaryMemoryService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditLogRepository,
  ) {}
  async policy(userId: string) {
    return this.database.database.transaction(
      async (tx) => {
        const [policy] = await tx
          .select()
          .from(diaryAiPolicies)
          .where(eq(diaryAiPolicies.userId, userId));
        const grants = await tx
          .select({ id: diaryAiGrants.notebookId })
          .from(diaryAiGrants)
          .innerJoin(diaryNotebooks, eq(diaryNotebooks.id, diaryAiGrants.notebookId))
          .where(and(eq(diaryAiGrants.userId, userId), eq(diaryNotebooks.userId, userId)))
          .orderBy(asc(diaryAiGrants.notebookId));
        return {
          mode: policy?.mode ?? ('none' as const),
          revision: policy?.revision ?? 0,
          notebookIds: policy?.mode === 'selected' ? grants.map((x) => x.id) : [],
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
  async updatePolicy(userId: string, input: DiaryAccessInput) {
    return this.database.database.transaction(async (tx) => {
      const [owner] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .for('update');
      if (!owner) throw new NotFoundError();
      const [current] = await tx
        .select()
        .from(diaryAiPolicies)
        .where(eq(diaryAiPolicies.userId, userId));
      if ((current?.revision ?? 0) !== input.expectedRevision)
        throw new ConflictError('读取权限已在其他地方修改，请重新读取后再保存');
      if (input.notebookIds.length) {
        const books = await tx
          .select({ id: diaryNotebooks.id })
          .from(diaryNotebooks)
          .where(
            and(eq(diaryNotebooks.userId, userId), inArray(diaryNotebooks.id, input.notebookIds)),
          );
        if (books.length !== input.notebookIds.length)
          throw new NotFoundError('所选日记本已不可用，请重新选择');
      }
      const revision = input.expectedRevision + 1;
      await tx
        .insert(diaryAiPolicies)
        .values({ userId, mode: input.mode, revision })
        .onConflictDoUpdate({
          target: diaryAiPolicies.userId,
          set: { mode: input.mode, revision },
        });
      await tx.delete(diaryAiGrants).where(eq(diaryAiGrants.userId, userId));
      if (input.mode === 'selected')
        await tx
          .insert(diaryAiGrants)
          .values(input.notebookIds.map((notebookId) => ({ userId, notebookId })));
      await this.audit.appendRequiredWithinTransaction(tx, {
        actorType: 'user',
        actorId: userId,
        action: 'diary_ai_access_changed',
        resourceType: 'diary_ai_access',
        resourceId: userId,
        idempotencyKey: `diary-access:${userId}:${revision}`,
        safeMetadata: {},
        occurredAt: new Date(),
      });
      return { mode: input.mode, revision, notebookIds: [...input.notebookIds].sort() };
    });
  }
  async retrieve(
    userId: string,
    query: string,
    signal: AbortSignal,
    now = new Date(),
  ): Promise<DiaryMemoryBundle | null> {
    signal.throwIfAborted();
    const policy = await this.policy(userId);
    if (policy.mode === 'none' || (policy.mode === 'selected' && !policy.notebookIds.length))
      return null;
    const { today, firstDay } = diaryWindow(now);
    const rows = await this.database.database
      .select({
        notebookId: diaryPages.notebookId,
        day: diaryPages.day,
        revision: diaryPages.revision,
        saved: diaryPages.saved,
      })
      .from(diaryPages)
      .innerJoin(diaryNotebooks, eq(diaryNotebooks.id, diaryPages.notebookId))
      .where(
        and(
          eq(diaryNotebooks.userId, userId),
          isNotNull(diaryPages.saved),
          gte(diaryPages.day, firstDay),
          lte(diaryPages.day, today),
          policy.mode === 'selected'
            ? inArray(diaryPages.notebookId, policy.notebookIds)
            : undefined,
        ),
      )
      .orderBy(desc(diaryPages.day), asc(diaryPages.notebookId))
      .limit(50);
    signal.throwIfAborted();
    const entries = rows.flatMap((row) => {
      const parsed = diaryContentSchema.safeParse(row.saved);
      if (!parsed.success || !parsed.data.body.trim()) return [];
      const { title, body, mood, weather } = parsed.data;
      return [
        {
          notebookId: row.notebookId,
          day: row.day,
          revision: row.revision,
          fingerprint: diaryFingerprint(parsed.data),
          title,
          body,
          mood,
          weather,
        },
      ];
    });
    const selected = selectDiaryEntries(entries, query);
    return selected.length ? { userId, policyRevision: policy.revision, entries: selected } : null;
  }
  async recheck(
    bundle: DiaryMemoryBundle | null | undefined,
    signal: AbortSignal,
    now = new Date(),
  ): Promise<void> {
    if (!bundle) return;
    signal.throwIfAborted();
    await this.database.database.transaction(
      async (tx) => {
        const [policy] = await tx
          .select()
          .from(diaryAiPolicies)
          .where(eq(diaryAiPolicies.userId, bundle.userId));
        const grants = await tx
          .select({ id: diaryAiGrants.notebookId })
          .from(diaryAiGrants)
          .where(eq(diaryAiGrants.userId, bundle.userId));
        const { today, firstDay } = diaryWindow(now);
        if (!policy || policy.mode === 'none' || policy.revision !== bundle.policyRevision)
          throw new AIProviderError('日记读取权限已改变，请重新发送消息');
        for (const entry of bundle.entries) {
          if (
            entry.day < firstDay ||
            entry.day > today ||
            (policy.mode === 'selected' && !grants.some((g) => g.id === entry.notebookId))
          )
            throw new AIProviderError('日记读取范围已改变，请重新发送消息');
          const [row] = await tx
            .select({ saved: diaryPages.saved })
            .from(diaryPages)
            .innerJoin(diaryNotebooks, eq(diaryNotebooks.id, diaryPages.notebookId))
            .where(
              and(
                eq(diaryNotebooks.userId, bundle.userId),
                eq(diaryPages.notebookId, entry.notebookId),
                eq(diaryPages.day, entry.day),
              ),
            );
          const parsed = diaryContentSchema.safeParse(row?.saved);
          if (!parsed.success || diaryFingerprint(parsed.data) !== entry.fingerprint)
            throw new AIProviderError('参考日记已修改或删除，请重新发送消息');
        }
        signal.throwIfAborted();
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
  async recordProvided(
    turnId: string,
    bundle: DiaryMemoryBundle | null | undefined,
  ): Promise<void> {
    if (!bundle) return;
    const [turn] = await this.database.database
      .select({ id: aiTurns.id })
      .from(aiTurns)
      .where(and(eq(aiTurns.id, turnId), eq(aiTurns.userId, bundle.userId)));
    if (!turn) throw new NotFoundError();
    await this.database.database
      .insert(diaryAiTurnReferences)
      .values({
        turnId,
        entries: bundle.entries.map(({ notebookId, day, revision }) => ({
          notebookId,
          day,
          revision,
        })),
      })
      .onConflictDoNothing();
  }
  async references(userId: string, turnId: string) {
    const [turn] = await this.database.database
      .select({ id: aiTurns.id })
      .from(aiTurns)
      .where(and(eq(aiTurns.id, turnId), eq(aiTurns.userId, userId)));
    if (!turn) throw new NotFoundError();
    const [record] = await this.database.database
      .select()
      .from(diaryAiTurnReferences)
      .where(eq(diaryAiTurnReferences.turnId, turnId));
    const entries = [];
    for (const entry of record?.entries ?? []) {
      const [row] = await this.database.database
        .select({ saved: diaryPages.saved, revision: diaryPages.revision })
        .from(diaryPages)
        .innerJoin(diaryNotebooks, eq(diaryNotebooks.id, diaryPages.notebookId))
        .where(
          and(
            eq(diaryNotebooks.userId, userId),
            eq(diaryPages.notebookId, entry.notebookId),
            eq(diaryPages.day, entry.day),
          ),
        );
      const current = Boolean(row?.saved && row.revision === entry.revision);
      entries.push({
        ...entry,
        title: current ? row!.saved!.title || '这一天的日记' : '日记已修改或删除',
        available: current,
      });
    }
    return { recorded: Boolean(record), entries };
  }
}
