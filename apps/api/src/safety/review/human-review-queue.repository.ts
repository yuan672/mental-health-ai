import { randomUUID } from 'node:crypto';
import {
  and,
  eq,
  humanReviewQueueItems,
  riskEvents,
  type ReviewPriority,
  type ReviewState,
} from '@mental-health/database';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { AuditLogRepository } from '../audit/audit-log.repository';
import type { RiskEventRecord } from '../persistence/risk-event.repository';

export type HumanReviewQueueRecord = Readonly<{
  id: string;
  riskEventId: string;
  priority: ReviewPriority;
  state: ReviewState;
  assignedReviewerId: string | null;
  createdAt: Date;
  startedAt: Date | null;
  reviewedAt: Date | null;
  resolutionCode: string | null;
}>;

export type HumanReviewContext = Readonly<{
  queueItem: HumanReviewQueueRecord;
  riskEvent: RiskEventRecord;
}>;

@Injectable()
export class HumanReviewQueueRepository {
  constructor(
    private readonly audits: AuditLogRepository,
    private readonly database: DatabaseService,
  ) {}

  async findByRiskEventId(riskEventId: string): Promise<HumanReviewQueueRecord | null> {
    const [item] = await this.database.database
      .select()
      .from(humanReviewQueueItems)
      .where(eq(humanReviewQueueItems.riskEventId, riskEventId))
      .limit(1);
    return item ?? null;
  }

  async findContextByRiskEventIdForReviewer(
    riskEventId: string,
    reviewerId: string,
    now: Date,
    authorize?: (transaction: import('@mental-health/database').AppTransaction) => Promise<void>,
  ): Promise<HumanReviewContext | null> {
    return this.database.database.transaction(async (transaction) => {
      await authorize?.(transaction);
      const [context] = await transaction
        .select({ queueItem: humanReviewQueueItems, riskEvent: riskEvents })
        .from(humanReviewQueueItems)
        .innerJoin(riskEvents, eq(riskEvents.id, humanReviewQueueItems.riskEventId))
        .where(eq(humanReviewQueueItems.riskEventId, riskEventId))
        .limit(1);
      if (!context) return null;
      await this.audits.appendWithinTransaction(transaction, {
        actorType: 'human_reviewer',
        actorId: reviewerId,
        action: 'risk_event_viewed',
        resourceType: 'risk_event',
        resourceId: riskEventId,
        idempotencyKey: `risk-event-viewed:${riskEventId}:${reviewerId}:${randomUUID()}`,
        safeMetadata: {},
        occurredAt: now,
      });
      return context;
    });
  }

  async claim(
    itemId: string,
    reviewerId: string,
    now: Date,
    authorize?: (transaction: import('@mental-health/database').AppTransaction) => Promise<void>,
  ): Promise<HumanReviewQueueRecord | null> {
    return this.database.database.transaction(async (transaction) => {
      await authorize?.(transaction);
      const [item] = await transaction
        .update(humanReviewQueueItems)
        .set({ state: 'in_review', assignedReviewerId: reviewerId, startedAt: now })
        .where(
          and(eq(humanReviewQueueItems.id, itemId), eq(humanReviewQueueItems.state, 'pending')),
        )
        .returning();
      if (!item) return null;
      await this.audits.appendWithinTransaction(transaction, {
        actorType: 'human_reviewer',
        actorId: reviewerId,
        action: 'review_started',
        resourceType: 'review_queue_item',
        resourceId: item.id,
        idempotencyKey: `review-started:${item.id}`,
        safeMetadata: {},
        occurredAt: now,
      });
      return item;
    });
  }

  async resolve(
    itemId: string,
    reviewerId: string,
    resolutionCode: string,
    now: Date,
    authorize?: (transaction: import('@mental-health/database').AppTransaction) => Promise<void>,
  ): Promise<HumanReviewQueueRecord | null> {
    return this.database.database.transaction(async (transaction) => {
      await authorize?.(transaction);
      const [item] = await transaction
        .update(humanReviewQueueItems)
        .set({ state: 'resolved', reviewedAt: now, resolutionCode })
        .where(
          and(
            eq(humanReviewQueueItems.id, itemId),
            eq(humanReviewQueueItems.state, 'in_review'),
            eq(humanReviewQueueItems.assignedReviewerId, reviewerId),
          ),
        )
        .returning();
      if (!item) return null;
      await this.audits.appendWithinTransaction(transaction, {
        actorType: 'human_reviewer',
        actorId: reviewerId,
        action: 'review_resolved',
        resourceType: 'review_queue_item',
        resourceId: item.id,
        idempotencyKey: `review-resolved:${item.id}`,
        safeMetadata: { resolutionCode },
        occurredAt: now,
      });
      return item;
    });
  }
}
