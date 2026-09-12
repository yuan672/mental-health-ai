import { randomUUID } from 'node:crypto';
import type {
  AppTransaction,
  ReviewPriority,
  ReviewState,
  RiskLevel,
} from '@mental-health/database';
import { Injectable } from '@nestjs/common';
import {
  AuthorizationError,
  ConflictError,
  DatabaseError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import { decodeOpaqueCursor, encodeOpaqueCursor } from '../common/pagination/opaque-cursor';
import { AuditLogRepository } from '../safety/audit/audit-log.repository';
import {
  HumanReviewQueueRepository,
  type HumanReviewQueueRecord,
} from '../safety/review/human-review-queue.repository';
import { reviewResolutionCodeSchema } from '../safety/review/human-review-queue.service';
import type { StaffAuthorizationContext } from './staff-access.types';
import { DatabaseStaffAuthorizer } from './staff-authorizer.service';
import {
  AdminSafetyReviewRepository,
  type AdminReviewQueueRecord,
  type AdminRiskEventRecord,
} from './admin-safety-review.repository';
import {
  adminReviewQueueCursorSchema,
  adminReviewQueueItemViewSchema,
  adminRiskEventCursorSchema,
  adminRiskEventViewSchema,
  type AdminReviewQueueListQuery,
  type AdminRiskEventListQuery,
} from './admin-safety-review.schemas';

function riskEventView(record: AdminRiskEventRecord) {
  return adminRiskEventViewSchema.parse({
    id: record.id,
    isIncognito: record.isIncognito,
    ordinaryContextReferenceAvailable:
      !record.isIncognito &&
      Boolean(record.conversationId || record.aiTurnId || record.triggerMessageId),
    level: record.level,
    riskCategories: record.riskCategories,
    reasonCodes: record.reasonCodes,
    detectionSource: record.detectionSource,
    policyVersion: record.policyVersion,
    classifierKey: record.classifierKey,
    classifierVersion: record.classifierVersion,
    createdAt: record.createdAt.toISOString(),
    retentionUntil: record.retentionUntil.toISOString(),
  });
}

function queueItemView(record: AdminReviewQueueRecord | HumanReviewQueueRecord) {
  return adminReviewQueueItemViewSchema.parse({
    id: record.id,
    riskEventId: record.riskEventId,
    priority: record.priority,
    state: record.state,
    assignedReviewerId: record.assignedReviewerId,
    createdAt: record.createdAt.toISOString(),
    startedAt: record.startedAt?.toISOString() ?? null,
    reviewedAt: record.reviewedAt?.toISOString() ?? null,
    resolutionCode: record.resolutionCode,
  });
}

@Injectable()
export class AdminSafetyReviewService {
  constructor(
    private readonly repository: AdminSafetyReviewRepository,
    private readonly queueRepository: HumanReviewQueueRepository,
    private readonly authorizer: DatabaseStaffAuthorizer,
    private readonly audits: AuditLogRepository,
  ) {}

  async listRiskEvents(
    actor: StaffAuthorizationContext,
    query: AdminRiskEventListQuery,
    now = new Date(),
  ) {
    const filters = {
      level: query.level ?? null,
      isIncognito: query.isIncognito ?? null,
    };
    const decoded = decodeOpaqueCursor(query.cursor, adminRiskEventCursorSchema);
    if (
      decoded &&
      (decoded.filters.level !== filters.level ||
        decoded.filters.isIncognito !== filters.isIncognito)
    ) {
      throw new ValidationError('分页游标与筛选条件不一致');
    }
    try {
      return await this.repository.transaction(async (tx) => {
        await this.authorizer.authorizeWithinTransaction(tx, actor, 'risk_event:read');
        const rows = await this.repository.listRiskEvents(tx, {
          limit: query.limit + 1,
          cursor: decoded ? { createdAt: new Date(decoded.createdAt), id: decoded.id } : null,
          level: filters.level,
          isIncognito: filters.isIncognito,
        });
        const selected = rows.slice(0, query.limit);
        const last = selected.at(-1);
        await this.appendListAudit(
          tx,
          actor.id,
          'risk_event_list_accessed',
          'risk_event_query',
          riskFilterCategory(filters.level, filters.isIncognito),
          selected.length,
          now,
        );
        return {
          riskEvents: selected.map(riskEventView),
          nextCursor:
            rows.length > query.limit && last
              ? encodeOpaqueCursor({
                  kind: 'admin-risk-events',
                  version: 1,
                  createdAt: last.createdAt.toISOString(),
                  id: last.id,
                  filters,
                })
              : null,
        };
      });
    } catch (error) {
      this.rethrow(error);
    }
  }

  async getRiskEvent(actor: StaffAuthorizationContext, id: string, now = new Date()) {
    try {
      return await this.repository.transaction(async (tx) => {
        await this.authorizer.authorizeWithinTransaction(tx, actor, 'risk_event:read');
        const detail = await this.repository.findRiskEventDetail(tx, id);
        if (!detail) throw new NotFoundError();
        await this.audits.appendWithinTransaction(tx, {
          actorType: 'staff',
          actorId: actor.id,
          action: 'risk_event_viewed',
          resourceType: 'risk_event',
          resourceId: id,
          idempotencyKey: `admin-risk-event-viewed:${id}:${actor.id}:${randomUUID()}`,
          safeMetadata: {},
          occurredAt: now,
        });
        return {
          riskEvent: riskEventView(detail.riskEvent),
          reviewQueueItem: detail.queueItem ? queueItemView(detail.queueItem) : null,
        };
      });
    } catch (error) {
      this.rethrow(error);
    }
  }

  async listReviewQueue(
    actor: StaffAuthorizationContext,
    query: AdminReviewQueueListQuery,
    now = new Date(),
  ) {
    const filters = { state: query.state ?? null, priority: query.priority ?? null };
    const decoded = decodeOpaqueCursor(query.cursor, adminReviewQueueCursorSchema);
    if (
      decoded &&
      (decoded.filters.state !== filters.state || decoded.filters.priority !== filters.priority)
    ) {
      throw new ValidationError('分页游标与筛选条件不一致');
    }
    try {
      return await this.repository.transaction(async (tx) => {
        await this.authorizer.authorizeWithinTransaction(tx, actor, 'risk_event:read');
        const rows = await this.repository.listReviewQueue(tx, {
          limit: query.limit + 1,
          cursor: decoded
            ? {
                priority: decoded.priority,
                createdAt: new Date(decoded.createdAt),
                id: decoded.id,
              }
            : null,
          state: filters.state,
          priority: filters.priority,
        });
        const selected = rows.slice(0, query.limit);
        const last = selected.at(-1)?.queueItem;
        await this.appendListAudit(
          tx,
          actor.id,
          'review_queue_list_accessed',
          'review_queue_query',
          queueFilterCategory(filters.state, filters.priority),
          selected.length,
          now,
        );
        return {
          queueItems: selected.map((row) => ({
            queueItem: queueItemView(row.queueItem),
            riskEvent: riskEventView(row.riskEvent),
          })),
          nextCursor:
            rows.length > query.limit && last
              ? encodeOpaqueCursor({
                  kind: 'admin-review-queue',
                  version: 1,
                  priority: last.priority,
                  createdAt: last.createdAt.toISOString(),
                  id: last.id,
                  filters,
                })
              : null,
        };
      });
    } catch (error) {
      this.rethrow(error);
    }
  }

  async claim(actor: StaffAuthorizationContext, itemId: string, now = new Date()) {
    try {
      return await this.repository.transaction(async (tx) => {
        await this.authorizer.authorizeWithinTransaction(tx, actor, 'review_queue:claim');
        const item = await this.queueRepository.claimWithinTransaction(tx, itemId, actor.id, now);
        if (!item) throw new ConflictError('审核项当前无法认领');
        await this.audits.appendWithinTransaction(tx, {
          actorType: 'staff',
          actorId: actor.id,
          action: 'review_started',
          resourceType: 'review_queue_item',
          resourceId: item.id,
          idempotencyKey: `review-started:${item.id}`,
          safeMetadata: {},
          occurredAt: now,
        });
        return { queueItem: queueItemView(item) };
      });
    } catch (error) {
      this.rethrow(error);
    }
  }

  async resolve(
    actor: StaffAuthorizationContext,
    itemId: string,
    resolutionCode: unknown,
    now = new Date(),
  ) {
    const parsedResolution = reviewResolutionCodeSchema.safeParse(resolutionCode);
    if (!parsedResolution.success) throw new ValidationError();
    try {
      return await this.repository.transaction(async (tx) => {
        await this.authorizer.authorizeWithinTransaction(tx, actor, 'review_queue:resolve');
        const item = await this.queueRepository.resolveWithinTransaction(
          tx,
          itemId,
          actor.id,
          parsedResolution.data,
          now,
        );
        if (!item) throw new ConflictError('审核项当前无法完成');
        await this.audits.appendWithinTransaction(tx, {
          actorType: 'staff',
          actorId: actor.id,
          action: 'review_resolved',
          resourceType: 'review_queue_item',
          resourceId: item.id,
          idempotencyKey: `review-resolved:${item.id}`,
          safeMetadata: { resolutionCode: parsedResolution.data },
          occurredAt: now,
        });
        return { queueItem: queueItemView(item) };
      });
    } catch (error) {
      this.rethrow(error);
    }
  }

  private appendListAudit(
    tx: AppTransaction,
    actorId: string,
    action: 'risk_event_list_accessed' | 'review_queue_list_accessed',
    resourceType: 'risk_event_query' | 'review_queue_query',
    filterCategory: string,
    returnedCount: number,
    now: Date,
  ): Promise<unknown> {
    return this.audits.appendWithinTransaction(tx, {
      actorType: 'staff',
      actorId,
      action,
      resourceType,
      resourceId: actorId,
      idempotencyKey: `${action}:${actorId}:${randomUUID()}`,
      safeMetadata: { filterCategory, returnedCount },
      occurredAt: now,
    });
  }

  private rethrow(error: unknown): never {
    if (
      error instanceof AuthorizationError ||
      error instanceof ConflictError ||
      error instanceof NotFoundError ||
      error instanceof ValidationError
    ) {
      throw error;
    }
    throw new DatabaseError();
  }
}

function riskFilterCategory(
  level: RiskLevel | null,
  isIncognito: boolean | null,
): 'all' | 'level' | 'incognito' | 'level_and_incognito' {
  if (level && isIncognito !== null) return 'level_and_incognito';
  if (level) return 'level';
  if (isIncognito !== null) return 'incognito';
  return 'all';
}

function queueFilterCategory(
  state: ReviewState | null,
  priority: ReviewPriority | null,
): 'all' | 'state' | 'priority' | 'state_and_priority' {
  if (state && priority) return 'state_and_priority';
  if (state) return 'state';
  if (priority) return 'priority';
  return 'all';
}
