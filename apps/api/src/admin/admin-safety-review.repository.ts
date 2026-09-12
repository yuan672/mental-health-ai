import {
  and,
  asc,
  desc,
  eq,
  gt,
  humanReviewQueueItems,
  lt,
  or,
  riskEvents,
  sql,
  type AppTransaction,
  type ReviewPriority,
  type ReviewState,
  type RiskLevel,
} from '@mental-health/database';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export type AdminRiskEventRecord = typeof riskEvents.$inferSelect;
export type AdminReviewQueueRecord = typeof humanReviewQueueItems.$inferSelect;
export type AdminRiskEventCursor = Readonly<{ createdAt: Date; id: string }>;
export type AdminReviewQueueCursor = Readonly<{
  priority: ReviewPriority;
  createdAt: Date;
  id: string;
}>;

@Injectable()
export class AdminSafetyReviewRepository {
  constructor(private readonly database: DatabaseService) {}

  transaction<T>(work: (tx: AppTransaction) => Promise<T>): Promise<T> {
    return this.database.database.transaction(work);
  }

  listRiskEvents(
    tx: AppTransaction,
    input: Readonly<{
      limit: number;
      cursor: AdminRiskEventCursor | null;
      level: RiskLevel | null;
      isIncognito: boolean | null;
    }>,
  ): Promise<AdminRiskEventRecord[]> {
    const cursorFilter = input.cursor
      ? or(
          lt(riskEvents.createdAt, input.cursor.createdAt),
          and(eq(riskEvents.createdAt, input.cursor.createdAt), lt(riskEvents.id, input.cursor.id)),
        )
      : undefined;
    return tx
      .select()
      .from(riskEvents)
      .where(
        and(
          input.level ? eq(riskEvents.level, input.level) : undefined,
          input.isIncognito === null ? undefined : eq(riskEvents.isIncognito, input.isIncognito),
          cursorFilter,
        ),
      )
      .orderBy(desc(riskEvents.createdAt), desc(riskEvents.id))
      .limit(input.limit);
  }

  async findRiskEventDetail(
    tx: AppTransaction,
    riskEventId: string,
  ): Promise<Readonly<{
    riskEvent: AdminRiskEventRecord;
    queueItem: AdminReviewQueueRecord | null;
  }> | null> {
    const [row] = await tx
      .select({ riskEvent: riskEvents, queueItem: humanReviewQueueItems })
      .from(riskEvents)
      .leftJoin(humanReviewQueueItems, eq(humanReviewQueueItems.riskEventId, riskEvents.id))
      .where(eq(riskEvents.id, riskEventId))
      .limit(1);
    return row ?? null;
  }

  listReviewQueue(
    tx: AppTransaction,
    input: Readonly<{
      limit: number;
      cursor: AdminReviewQueueCursor | null;
      state: ReviewState | null;
      priority: ReviewPriority | null;
    }>,
  ): Promise<
    ReadonlyArray<{ queueItem: AdminReviewQueueRecord; riskEvent: AdminRiskEventRecord }>
  > {
    const priorityRank = sql<number>`CASE WHEN ${humanReviewQueueItems.priority} = 'urgent' THEN 0 ELSE 1 END`;
    const cursorRank = input.cursor?.priority === 'urgent' ? 0 : 1;
    const cursorFilter = input.cursor
      ? or(
          sql`${priorityRank} > ${cursorRank}`,
          and(
            sql`${priorityRank} = ${cursorRank}`,
            or(
              gt(humanReviewQueueItems.createdAt, input.cursor.createdAt),
              and(
                eq(humanReviewQueueItems.createdAt, input.cursor.createdAt),
                gt(humanReviewQueueItems.id, input.cursor.id),
              ),
            ),
          ),
        )
      : undefined;
    return tx
      .select({ queueItem: humanReviewQueueItems, riskEvent: riskEvents })
      .from(humanReviewQueueItems)
      .innerJoin(riskEvents, eq(riskEvents.id, humanReviewQueueItems.riskEventId))
      .where(
        and(
          input.state ? eq(humanReviewQueueItems.state, input.state) : undefined,
          input.priority ? eq(humanReviewQueueItems.priority, input.priority) : undefined,
          cursorFilter,
        ),
      )
      .orderBy(
        asc(priorityRank),
        asc(humanReviewQueueItems.createdAt),
        asc(humanReviewQueueItems.id),
      )
      .limit(input.limit);
  }
}
