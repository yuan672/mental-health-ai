import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, lt, lte, moodEntries, or, sql } from '@mental-health/database';
import type { MoodCat, MoodEmotion } from '@mental-health/types';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AuditLogRepository } from '../safety/audit/audit-log.repository';
import type { MoodDateRange } from './mood-date-range.policy';

export type MoodEntryRecord = Readonly<{
  id: string;
  userId: string;
  clientRequestId: string;
  moodScore: number | null;
  catMood: MoodCat | null;
  emotion: MoodEmotion | null;
  note: string | null;
  stateRevision: number;
  createdAt: Date;
  updatedAt: Date;
}>;

export type MoodHistoryCursor = Readonly<{ createdAt: Date; id: string }>;
export type MoodTrendRecord = Readonly<{
  localDate: string;
  entryCount: number;
  averageMoodScore: number | null;
  latestEntry: { catMood: MoodCat | null; moodScore: number | null; emotion: MoodEmotion | null };
}>;

type MutationResult =
  { kind: 'ok'; entry: MoodEntryRecord } | { kind: 'not_found' } | { kind: 'state_changed' };

@Injectable()
export class MoodRepository {
  constructor(
    private readonly audits: AuditLogRepository,
    private readonly database: DatabaseService,
  ) {}

  protected async afterHistoryEntriesRead(): Promise<void> {
    return Promise.resolve();
  }

  async create(input: MoodEntryRecord): Promise<{
    entry: MoodEntryRecord;
    disposition: 'created' | 'existing';
  }> {
    const inserted = await this.database.database
      .insert(moodEntries)
      .values(input)
      .onConflictDoNothing({ target: [moodEntries.userId, moodEntries.clientRequestId] })
      .returning();
    const created = inserted[0];
    if (created) return { entry: created, disposition: 'created' };

    const existing = await this.findByClientRequestId(input.userId, input.clientRequestId);
    if (!existing) throw new Error('Mood create conflict resolved without a visible row');
    return { entry: existing, disposition: 'existing' };
  }

  async findByClientRequestId(
    userId: string,
    clientRequestId: string,
  ): Promise<MoodEntryRecord | null> {
    const [entry] = await this.database.database
      .select()
      .from(moodEntries)
      .where(and(eq(moodEntries.userId, userId), eq(moodEntries.clientRequestId, clientRequestId)))
      .limit(1);
    return entry ?? null;
  }

  async findOwnedById(userId: string, id: string): Promise<MoodEntryRecord | null> {
    const [entry] = await this.database.database
      .select()
      .from(moodEntries)
      .where(and(eq(moodEntries.userId, userId), eq(moodEntries.id, id)))
      .limit(1);
    return entry ?? null;
  }

  async listWithTrend(input: {
    userId: string;
    range: MoodDateRange;
    cursor: MoodHistoryCursor | null;
    limit: number;
  }): Promise<{ entries: MoodEntryRecord[]; dailyTrend: MoodTrendRecord[] }> {
    return this.database.database.transaction(
      async (transaction) => {
        const cursorPredicate = input.cursor
          ? or(
              lt(moodEntries.createdAt, input.cursor.createdAt),
              and(
                eq(moodEntries.createdAt, input.cursor.createdAt),
                lt(moodEntries.id, input.cursor.id),
              ),
            )
          : undefined;
        const commonPredicate = and(
          eq(moodEntries.userId, input.userId),
          gte(moodEntries.createdAt, input.range.start),
          lt(moodEntries.createdAt, input.range.end),
          lte(moodEntries.createdAt, input.range.createdAtCeiling),
        );
        const entries = await transaction
          .select()
          .from(moodEntries)
          .where(and(commonPredicate, cursorPredicate))
          .orderBy(desc(moodEntries.createdAt), desc(moodEntries.id))
          .limit(input.limit);
        await this.afterHistoryEntriesRead();

        const dateExpression = sql<string>`to_char(${moodEntries.createdAt} AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD')`;
        const trend = await transaction
          .select({
            localDate: dateExpression,
            entryCount: sql<number>`count(*)::int`,
            averageMoodScore: sql<
              string | null
            >`round(avg(${moodEntries.moodScore})::numeric, 1)::text`,
            latestCat: sql<MoodCat | null>`(array_agg(${moodEntries.catMood} ORDER BY ${moodEntries.createdAt} DESC, ${moodEntries.id} DESC))[1]`,
            latestScore: sql<
              number | null
            >`(array_agg(${moodEntries.moodScore} ORDER BY ${moodEntries.createdAt} DESC, ${moodEntries.id} DESC))[1]`,
            latestEmotion: sql<MoodEmotion | null>`(array_agg(${moodEntries.emotion} ORDER BY ${moodEntries.createdAt} DESC, ${moodEntries.id} DESC))[1]`,
          })
          .from(moodEntries)
          .where(commonPredicate)
          .groupBy(dateExpression)
          .orderBy(asc(dateExpression));

        return {
          entries,
          dailyTrend: trend.map((row) => ({
            localDate: row.localDate,
            entryCount: Number(row.entryCount),
            averageMoodScore: row.averageMoodScore === null ? null : Number(row.averageMoodScore),
            latestEntry: {
              catMood: row.latestCat,
              moodScore: row.latestScore,
              emotion: row.latestEmotion,
            },
          })),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async update(input: {
    userId: string;
    id: string;
    expectedRevision: number;
    moodScore: number | null;
    catMood: MoodCat | null;
    emotion: MoodEmotion | null;
    note: string | null;
    now: Date;
  }): Promise<MutationResult> {
    return this.database.database.transaction(async (transaction) => {
      const [current] = await transaction
        .select()
        .from(moodEntries)
        .where(and(eq(moodEntries.userId, input.userId), eq(moodEntries.id, input.id)))
        .limit(1)
        .for('update');
      if (!current) return { kind: 'not_found' };
      if (current.stateRevision !== input.expectedRevision) return { kind: 'state_changed' };
      if (
        current.moodScore === input.moodScore &&
        current.catMood === input.catMood &&
        current.emotion === input.emotion &&
        current.note === input.note
      ) {
        return { kind: 'ok', entry: current };
      }

      const [updated] = await transaction
        .update(moodEntries)
        .set({
          moodScore: input.moodScore,
          catMood: input.catMood,
          emotion: input.emotion,
          note: input.note,
          stateRevision: current.stateRevision + 1,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(moodEntries.id, input.id),
            eq(moodEntries.userId, input.userId),
            eq(moodEntries.stateRevision, input.expectedRevision),
          ),
        )
        .returning();
      if (!updated) return { kind: 'state_changed' };
      return { kind: 'ok', entry: updated };
    });
  }

  async delete(input: {
    userId: string;
    id: string;
    expectedRevision: number;
    now: Date;
  }): Promise<'deleted' | 'not_found' | 'state_changed'> {
    return this.database.database.transaction(async (transaction) => {
      const [current] = await transaction
        .select({ id: moodEntries.id, stateRevision: moodEntries.stateRevision })
        .from(moodEntries)
        .where(and(eq(moodEntries.userId, input.userId), eq(moodEntries.id, input.id)))
        .limit(1)
        .for('update');
      if (!current) return 'not_found';
      if (current.stateRevision !== input.expectedRevision) return 'state_changed';

      const deleted = await transaction
        .delete(moodEntries)
        .where(
          and(
            eq(moodEntries.userId, input.userId),
            eq(moodEntries.id, input.id),
            eq(moodEntries.stateRevision, input.expectedRevision),
          ),
        )
        .returning({ id: moodEntries.id });
      if (deleted.length !== 1) return 'state_changed';
      await this.audits.appendWithinTransaction(transaction, {
        actorType: 'user',
        actorId: input.userId,
        action: 'mood_entry_deleted',
        resourceType: 'mood_entry',
        resourceId: input.id,
        idempotencyKey: `mood_entry_deleted:${input.userId}:${input.id}`,
        safeMetadata: {},
        occurredAt: input.now,
      });
      return 'deleted';
    });
  }

  async deleteAll(userId: string, now: Date): Promise<number> {
    return this.database.database.transaction(async (transaction) => {
      const deleted = await transaction
        .delete(moodEntries)
        .where(eq(moodEntries.userId, userId))
        .returning({ id: moodEntries.id });
      if (deleted.length === 0) return 0;

      await this.audits.appendWithinTransaction(transaction, {
        actorType: 'user',
        actorId: userId,
        action: 'mood_history_deleted',
        resourceType: 'mood_history',
        resourceId: userId,
        idempotencyKey: `mood_history_deleted:${userId}:${randomUUID()}`,
        safeMetadata: { entryCount: deleted.length },
        occurredAt: now,
      });
      return deleted.length;
    });
  }
}
