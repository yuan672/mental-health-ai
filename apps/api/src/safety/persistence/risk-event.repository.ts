import { randomUUID } from 'node:crypto';
import {
  and,
  eq,
  humanReviewQueueItems,
  inArray,
  lte,
  riskEvents,
  type AppTransaction,
} from '@mental-health/database';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import type { AssessedRiskDecision } from '../safety.types';
import { AuditLogRepository } from '../audit/audit-log.repository';
import { RiskEventRetentionPolicy } from './safety-retention.policy';

export type PersistRiskEventInput = Readonly<{
  userId: string;
  conversationId: string | null;
  aiTurnId: string | null;
  triggerMessageId: string | null;
  clientRequestId: string;
  isIncognito: boolean;
  decision: AssessedRiskDecision;
  createdAt: Date;
  trustedAction?: Readonly<{
    action: 'crisis_flow_triggered' | 'trusted_safety_response_created';
    templateKey: string;
    templateVersion: string;
  }>;
}>;

export type RiskEventRecord = Readonly<{
  id: string;
  userId: string | null;
  conversationId: string | null;
  aiTurnId: string | null;
  triggerMessageId: string | null;
  clientRequestId: string;
  isIncognito: boolean;
  level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  riskCategories: string[];
  reasonCodes: string[];
  detectionSource: string;
  policyVersion: string;
  classifierKey: string | null;
  classifierVersion: string | null;
  createdAt: Date;
  retentionUntil: Date;
}>;

@Injectable()
export class RiskEventRepository {
  constructor(
    private readonly audits: AuditLogRepository,
    private readonly database: DatabaseService,
    private readonly retention: RiskEventRetentionPolicy,
  ) {}

  async persist(input: PersistRiskEventInput): Promise<RiskEventRecord> {
    return this.database.database.transaction((transaction) =>
      this.persistWithinTransaction(transaction, input),
    );
  }

  async persistWithinTransaction(
    transaction: AppTransaction,
    input: PersistRiskEventInput,
  ): Promise<RiskEventRecord> {
    const id = randomUUID();
    const [inserted] = await transaction
      .insert(riskEvents)
      .values({
        id,
        userId: input.userId,
        conversationId: input.conversationId,
        aiTurnId: input.aiTurnId,
        triggerMessageId: input.triggerMessageId,
        clientRequestId: input.clientRequestId,
        isIncognito: input.isIncognito,
        level: input.decision.level,
        riskCategories: [...input.decision.categories],
        reasonCodes: [...input.decision.reasonCodes],
        detectionSource: input.decision.detectionSource,
        policyVersion: input.decision.policyVersion,
        classifierKey: input.decision.classifierKey,
        classifierVersion: input.decision.classifierVersion,
        createdAt: input.createdAt,
        retentionUntil: this.retention.getRetentionUntil(input.createdAt),
      })
      .onConflictDoNothing()
      .returning();

    const event = inserted ?? (await this.findExisting(transaction, input));
    if (!event) throw new Error('Risk Event conflict did not resolve to an existing record');
    if (!inserted) return event;

    await this.audits.appendWithinTransaction(transaction, {
      actorType: 'system',
      actorId: null,
      action: 'risk_event_created',
      resourceType: 'risk_event',
      resourceId: event.id,
      idempotencyKey: `risk-event-created:${event.id}`,
      safeMetadata: {},
      occurredAt: input.createdAt,
    });

    if (input.decision.level === 'HIGH' || input.decision.level === 'CRITICAL') {
      const priority = input.decision.level === 'CRITICAL' ? 'urgent' : 'high';
      await transaction
        .insert(humanReviewQueueItems)
        .values({
          id: randomUUID(),
          riskEventId: event.id,
          priority,
          state: 'pending',
          createdAt: input.createdAt,
        })
        .onConflictDoNothing({ target: humanReviewQueueItems.riskEventId });
      await this.audits.appendWithinTransaction(transaction, {
        actorType: 'system',
        actorId: null,
        action: 'review_queue_created',
        resourceType: 'risk_event',
        resourceId: event.id,
        idempotencyKey: `review-queue-created:${event.id}`,
        safeMetadata: { priority },
        occurredAt: input.createdAt,
      });
    }

    if (input.trustedAction) {
      await this.audits.appendWithinTransaction(transaction, {
        actorType: 'system',
        actorId: null,
        action: input.trustedAction.action,
        resourceType: 'risk_event',
        resourceId: event.id,
        idempotencyKey: `${input.trustedAction.action}:${event.id}`,
        safeMetadata: {
          templateKey: input.trustedAction.templateKey,
          templateVersion: input.trustedAction.templateVersion,
        },
        occurredAt: input.createdAt,
      });
    }
    return event;
  }

  async purgeExpired(now: Date, batchSize: number): Promise<number> {
    return this.database.database.transaction(async (transaction) => {
      const candidates = await transaction
        .select({ id: riskEvents.id })
        .from(riskEvents)
        .where(lte(riskEvents.retentionUntil, now))
        .limit(batchSize);
      if (candidates.length === 0) return 0;
      const deleted = await transaction
        .delete(riskEvents)
        .where(
          inArray(
            riskEvents.id,
            candidates.map((candidate) => candidate.id),
          ),
        )
        .returning({ id: riskEvents.id });
      return deleted.length;
    });
  }

  private async findExisting(
    transaction: AppTransaction,
    input: PersistRiskEventInput,
  ): Promise<RiskEventRecord | null> {
    const condition = input.aiTurnId
      ? eq(riskEvents.aiTurnId, input.aiTurnId)
      : and(
          eq(riskEvents.userId, input.userId),
          eq(riskEvents.clientRequestId, input.clientRequestId),
          eq(riskEvents.isIncognito, true),
        );
    const [event] = await transaction.select().from(riskEvents).where(condition).limit(1);
    return event ?? null;
  }
}
