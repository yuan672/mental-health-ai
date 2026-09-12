import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AuthorizationError, DatabaseError, ValidationError } from '../common/errors';
import { decodeOpaqueCursor, encodeOpaqueCursor } from '../common/pagination/opaque-cursor';
import { AuditLogRepository } from '../safety/audit/audit-log.repository';
import type { StaffAuthorizationContext } from './staff-access.types';
import { DatabaseStaffAuthorizer } from './staff-authorizer.service';
import {
  AdminAuditReadRepository,
  type AdminAuditReadRepositoryQuery,
} from './admin-audit-read.repository';
import {
  READABLE_AUDIT_ACTIONS,
  adminAuditReadCursorSchema,
  adminAuditReadDataSchema,
  adminAuditReadQuerySchema,
  isReadableAuditActionResourcePair,
  type AdminAuditReadCursor,
  type AdminAuditReadData,
  type AdminAuditReadQuery,
  type ReadableAuditAction,
  type ReadableAuditResourceType,
} from './admin-audit-read.schemas';
import { presentAdminAuditRecord } from './admin-audit-read.presenter';

const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_WINDOW_MS = 7 * DAY_MS;
const MAX_WINDOW_MS = 31 * DAY_MS;
const MAX_CURSOR_LENGTH = 512;

type NormalizedAuditRead = Readonly<{
  action: ReadableAuditAction | null;
  resourceType: ReadableAuditResourceType | null;
  occurredFrom: Date;
  occurredBefore: Date;
  mode: 'd' | 'e';
  cursor: Readonly<{ occurredAt: Date; id: string }> | null;
  pageKind: 'initial' | 'continuation';
  filterCategory: 'all' | 'action' | 'resource_type' | 'time_range' | 'combined';
}>;

@Injectable()
export class AdminAuditReadService {
  constructor(
    private readonly repository: AdminAuditReadRepository,
    private readonly authorizer: DatabaseStaffAuthorizer,
    private readonly audits: AuditLogRepository,
  ) {}

  async list(
    actor: StaffAuthorizationContext,
    query: AdminAuditReadQuery,
    observedAt = new Date(),
  ): Promise<AdminAuditReadData> {
    const parsedQuery = adminAuditReadQuerySchema.safeParse(query);
    if (!parsedQuery.success) throw new ValidationError();
    const validatedQuery = parsedQuery.data;
    const normalized = normalizeQuery(validatedQuery, observedAt);
    const repositoryQuery: AdminAuditReadRepositoryQuery = {
      readableActions: READABLE_AUDIT_ACTIONS,
      action: normalized.action,
      resourceType: normalized.resourceType,
      occurredFrom: normalized.occurredFrom,
      occurredBefore: normalized.occurredBefore,
      observedAt,
      cursor: normalized.cursor,
      limit: validatedQuery.limit + 1,
    };

    try {
      return await this.repository.readTransaction(async (tx) => {
        await this.authorizer.authorizeWithinTransaction(tx, actor, 'audit:read');
        const rows = await this.repository.list(tx, repositoryQuery);

        // Validate the sentinel row too. A malformed selected row must not be hidden
        // merely because it falls just beyond the requested page size.
        const projected = rows.map((row) => presentAdminAuditRecord(row));
        const records = projected.slice(0, validatedQuery.limit);
        const hasMore = rows.length > validatedQuery.limit;
        const last = hasMore ? rows[validatedQuery.limit - 1] : undefined;
        const nextCursor = last
          ? encodeCursor({
              k: 'aal',
              v: 1,
              a: normalized.action,
              r: normalized.resourceType,
              f: normalized.occurredFrom.toISOString(),
              b: normalized.occurredBefore.toISOString(),
              m: normalized.mode,
              t: last.occurredAt.toISOString(),
              i: last.id,
            })
          : null;

        await this.audits.appendRequiredWithinTransaction(tx, {
          actorType: 'staff',
          actorId: actor.id,
          action: 'audit_log_accessed',
          resourceType: 'audit_log_query',
          resourceId: actor.id,
          idempotencyKey: `audit-log-accessed:${randomUUID()}`,
          safeMetadata: {
            filterCategory: normalized.filterCategory,
            pageKind: normalized.pageKind,
            returnedCount: records.length,
          },
          occurredAt: observedAt,
        });

        return adminAuditReadDataSchema.parse({
          observedAt: observedAt.toISOString(),
          period: {
            occurredFrom: normalized.occurredFrom.toISOString(),
            occurredBefore: normalized.occurredBefore.toISOString(),
          },
          records,
          nextCursor,
        });
      });
    } catch (error) {
      if (error instanceof AuthorizationError || error instanceof ValidationError) {
        throw error;
      }
      throw new DatabaseError();
    }
  }
}

function normalizeQuery(query: AdminAuditReadQuery, observedAt: Date): NormalizedAuditRead {
  if (!Number.isFinite(observedAt.getTime())) throw new ValidationError('请求时间无效');
  const decoded = decodeOpaqueCursor(query.cursor, adminAuditReadCursorSchema);
  if (decoded) return normalizeContinuation(query, decoded, observedAt);

  const hasFrom = query.occurredFrom !== undefined;
  const hasBefore = query.occurredBefore !== undefined;
  if (hasFrom !== hasBefore) throw new ValidationError('时间范围必须同时提供起止时间');

  const occurredBefore = hasBefore ? parseTimestamp(query.occurredBefore!) : observedAt;
  const occurredFrom = hasFrom
    ? parseTimestamp(query.occurredFrom!)
    : new Date(occurredBefore.getTime() - DEFAULT_WINDOW_MS);
  validateWindow(occurredFrom, occurredBefore, observedAt);
  validateFilterPair(query.action ?? null, query.resourceType ?? null);

  return {
    action: query.action ?? null,
    resourceType: query.resourceType ?? null,
    occurredFrom,
    occurredBefore,
    mode: hasFrom ? 'e' : 'd',
    cursor: null,
    pageKind: 'initial',
    filterCategory: filterCategory(query.action ?? null, query.resourceType ?? null, hasFrom),
  };
}

function normalizeContinuation(
  query: AdminAuditReadQuery,
  cursor: AdminAuditReadCursor,
  observedAt: Date,
): NormalizedAuditRead {
  const occurredFrom = parseTimestamp(cursor.f);
  const occurredBefore = parseTimestamp(cursor.b);
  const lastOccurredAt = parseTimestamp(cursor.t);
  validateWindow(occurredFrom, occurredBefore, observedAt);
  if (cursor.m === 'd' && occurredBefore.getTime() - occurredFrom.getTime() !== DEFAULT_WINDOW_MS) {
    throw new ValidationError('默认分页时间范围无效');
  }
  if (
    lastOccurredAt.getTime() < occurredFrom.getTime() ||
    lastOccurredAt.getTime() >= occurredBefore.getTime()
  ) {
    throw new ValidationError('分页游标位置无效');
  }
  validateFilterPair(cursor.a, cursor.r);

  if (query.action !== undefined && query.action !== cursor.a) {
    throw new ValidationError('分页筛选条件不一致');
  }
  if (query.resourceType !== undefined && query.resourceType !== cursor.r) {
    throw new ValidationError('分页筛选条件不一致');
  }
  const repeatsTime = query.occurredFrom !== undefined || query.occurredBefore !== undefined;
  if (repeatsTime) {
    if (query.occurredFrom === undefined || query.occurredBefore === undefined) {
      throw new ValidationError('时间范围必须同时提供起止时间');
    }
    if (
      parseTimestamp(query.occurredFrom).getTime() !== occurredFrom.getTime() ||
      parseTimestamp(query.occurredBefore).getTime() !== occurredBefore.getTime()
    ) {
      throw new ValidationError('分页时间范围不一致');
    }
  }

  return {
    action: cursor.a,
    resourceType: cursor.r,
    occurredFrom,
    occurredBefore,
    mode: cursor.m,
    cursor: { occurredAt: lastOccurredAt, id: cursor.i },
    pageKind: 'continuation',
    filterCategory: filterCategory(cursor.a, cursor.r, cursor.m === 'e'),
  };
}

function validateWindow(from: Date, before: Date, observedAt: Date): void {
  const duration = before.getTime() - from.getTime();
  if (duration <= 0 || duration > MAX_WINDOW_MS || before.getTime() > observedAt.getTime()) {
    throw new ValidationError('时间范围无效');
  }
}

function validateFilterPair(
  action: ReadableAuditAction | null,
  resourceType: ReadableAuditResourceType | null,
): void {
  if (action && resourceType && !isReadableAuditActionResourcePair(action, resourceType)) {
    throw new ValidationError('审计动作与资源类型不匹配');
  }
}

function filterCategory(
  action: ReadableAuditAction | null,
  resourceType: ReadableAuditResourceType | null,
  explicitTime: boolean,
): NormalizedAuditRead['filterCategory'] {
  const count = Number(Boolean(action)) + Number(Boolean(resourceType)) + Number(explicitTime);
  if (count > 1) return 'combined';
  if (action) return 'action';
  if (resourceType) return 'resource_type';
  if (explicitTime) return 'time_range';
  return 'all';
}

function parseTimestamp(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new ValidationError('时间格式无效');
  return parsed;
}

function encodeCursor(cursor: AdminAuditReadCursor): string {
  const encoded = encodeOpaqueCursor(adminAuditReadCursorSchema.parse(cursor));
  if (encoded.length > MAX_CURSOR_LENGTH) {
    throw new Error('Generated Audit cursor exceeded its public bound');
  }
  return encoded;
}
