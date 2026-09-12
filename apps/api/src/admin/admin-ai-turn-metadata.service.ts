import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  AuthorizationError,
  DatabaseError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import { decodeOpaqueCursor, encodeOpaqueCursor } from '../common/pagination/opaque-cursor';
import { AuditLogRepository } from '../safety/audit/audit-log.repository';
import { presentAdminAiTurnMetadata } from './admin-ai-turn-metadata.presenter';
import {
  AdminAiTurnMetadataRepository,
  type AdminAiTurnMetadataRepositoryQuery,
} from './admin-ai-turn-metadata.repository';
import {
  adminAiTurnIdSchema,
  adminAiTurnMetadataCursorSchema,
  adminAiTurnMetadataDetailDataSchema,
  adminAiTurnMetadataListDataSchema,
  adminAiTurnMetadataQuerySchema,
  type AdminAiTurnMetadataCursor,
  type AdminAiTurnMetadataDetailData,
  type AdminAiTurnMetadataListData,
  type AdminAiTurnMetadataQuery,
  type AdminAiTurnStatus,
} from './admin-ai-turn-metadata.schemas';
import type { StaffAuthorizationContext } from './staff-access.types';
import { DatabaseStaffAuthorizer } from './staff-authorizer.service';

const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_WINDOW_MS = 7 * DAY_MS;
const MAX_WINDOW_MS = 31 * DAY_MS;
const MAX_CURSOR_LENGTH = 512;

type NormalizedTurnRead = Readonly<{
  status: AdminAiTurnStatus | null;
  createdFrom: Date;
  createdBefore: Date;
  mode: 'd' | 'e';
  cursor: Readonly<{ createdAt: Date; id: string }> | null;
  filterCategory: 'all' | 'status' | 'time_range' | 'status_and_time';
}>;

@Injectable()
export class AdminAiTurnMetadataClock {
  now(): Date {
    return new Date();
  }
}

@Injectable()
export class AdminAiTurnMetadataService {
  constructor(
    private readonly repository: AdminAiTurnMetadataRepository,
    private readonly authorizer: DatabaseStaffAuthorizer,
    private readonly audits: AuditLogRepository,
    private readonly clock: AdminAiTurnMetadataClock,
  ) {}

  async list(
    actor: StaffAuthorizationContext,
    query: AdminAiTurnMetadataQuery,
  ): Promise<AdminAiTurnMetadataListData> {
    const parsedQuery = adminAiTurnMetadataQuerySchema.safeParse(query);
    if (!parsedQuery.success) throw new ValidationError();
    const validatedQuery = parsedQuery.data;

    try {
      return await this.repository.readTransaction(async (tx) => {
        await this.authorizer.authorizeWithinTransaction(tx, actor, 'ai_quality:read_metadata');
        const observedAt = this.clock.now();
        const normalized = normalizeQuery(validatedQuery, observedAt);
        const repositoryQuery: AdminAiTurnMetadataRepositoryQuery = {
          status: normalized.status,
          createdFrom: normalized.createdFrom,
          createdBefore: normalized.createdBefore,
          observedAt,
          cursor: normalized.cursor,
          limit: validatedQuery.limit + 1,
        };
        const rows = await this.repository.list(tx, repositoryQuery);
        const projected = rows.map((row) => presentAdminAiTurnMetadata(row, observedAt));
        const turns = projected.slice(0, validatedQuery.limit);
        const hasMore = rows.length > validatedQuery.limit;
        const last = hasMore ? rows[validatedQuery.limit - 1] : undefined;
        const nextCursor = last
          ? encodeCursor({
              k: 'aqt',
              v: 1,
              s: normalized.status,
              f: normalized.createdFrom.toISOString(),
              b: normalized.createdBefore.toISOString(),
              m: normalized.mode,
              t: last.createdAt.toISOString(),
              i: last.id,
            })
          : null;

        await this.audits.appendRequiredWithinTransaction(tx, {
          actorType: 'staff',
          actorId: actor.id,
          action: 'ai_quality_metadata_accessed',
          resourceType: 'ai_turn_query',
          resourceId: actor.id,
          idempotencyKey: `ai-quality-metadata-accessed:${randomUUID()}`,
          safeMetadata: {
            accessCategory: 'list',
            filterCategory: normalized.filterCategory,
            returnedCount: turns.length,
          },
          occurredAt: observedAt,
        });

        return adminAiTurnMetadataListDataSchema.parse({
          observedAt: observedAt.toISOString(),
          period: {
            createdFrom: normalized.createdFrom.toISOString(),
            createdBefore: normalized.createdBefore.toISOString(),
          },
          turns,
          nextCursor,
        });
      });
    } catch (error) {
      if (error instanceof AuthorizationError || error instanceof ValidationError) throw error;
      throw new DatabaseError();
    }
  }

  async get(
    actor: StaffAuthorizationContext,
    turnId: string,
  ): Promise<AdminAiTurnMetadataDetailData> {
    const parsedTurnId = adminAiTurnIdSchema.safeParse(turnId);
    if (!parsedTurnId.success) {
      throw new ValidationError();
    }
    try {
      return await this.repository.readTransaction(async (tx) => {
        await this.authorizer.authorizeWithinTransaction(tx, actor, 'ai_quality:read_metadata');
        const observedAt = this.clock.now();
        if (!Number.isFinite(observedAt.getTime())) throw new ValidationError();
        const row = await this.repository.findVisibleById(tx, parsedTurnId.data, observedAt);
        if (!row) throw new NotFoundError();
        const turn = presentAdminAiTurnMetadata(row, observedAt);

        await this.audits.appendRequiredWithinTransaction(tx, {
          actorType: 'staff',
          actorId: actor.id,
          action: 'ai_quality_metadata_accessed',
          resourceType: 'ai_turn',
          resourceId: parsedTurnId.data,
          idempotencyKey: `ai-quality-metadata-accessed:${randomUUID()}`,
          safeMetadata: {
            accessCategory: 'detail',
            filterCategory: 'id',
            returnedCount: 1,
          },
          occurredAt: observedAt,
        });

        return adminAiTurnMetadataDetailDataSchema.parse({
          observedAt: observedAt.toISOString(),
          turn,
        });
      });
    } catch (error) {
      if (
        error instanceof AuthorizationError ||
        error instanceof ValidationError ||
        error instanceof NotFoundError
      ) {
        throw error;
      }
      throw new DatabaseError();
    }
  }
}

function normalizeQuery(query: AdminAiTurnMetadataQuery, observedAt: Date): NormalizedTurnRead {
  if (!Number.isFinite(observedAt.getTime())) throw new ValidationError('请求时间无效');
  const decoded = decodeOpaqueCursor(query.cursor, adminAiTurnMetadataCursorSchema);
  if (decoded) return normalizeContinuation(query, decoded, observedAt);

  const hasFrom = query.createdFrom !== undefined;
  const hasBefore = query.createdBefore !== undefined;
  if (hasFrom !== hasBefore) throw new ValidationError('时间范围必须同时提供起止时间');
  const createdBefore = hasBefore ? parseTimestamp(query.createdBefore!) : observedAt;
  const createdFrom = hasFrom
    ? parseTimestamp(query.createdFrom!)
    : new Date(createdBefore.getTime() - DEFAULT_WINDOW_MS);
  validateWindow(createdFrom, createdBefore, observedAt);
  const status = query.status ?? null;

  return {
    status,
    createdFrom,
    createdBefore,
    mode: hasFrom ? 'e' : 'd',
    cursor: null,
    filterCategory: filterCategory(status, hasFrom),
  };
}

function normalizeContinuation(
  query: AdminAiTurnMetadataQuery,
  cursor: AdminAiTurnMetadataCursor,
  observedAt: Date,
): NormalizedTurnRead {
  const createdFrom = parseTimestamp(cursor.f);
  const createdBefore = parseTimestamp(cursor.b);
  const lastCreatedAt = parseTimestamp(cursor.t);
  validateWindow(createdFrom, createdBefore, observedAt);
  if (cursor.m === 'd' && createdBefore.getTime() - createdFrom.getTime() !== DEFAULT_WINDOW_MS) {
    throw new ValidationError('默认分页时间范围无效');
  }
  if (
    lastCreatedAt.getTime() < createdFrom.getTime() ||
    lastCreatedAt.getTime() >= createdBefore.getTime()
  ) {
    throw new ValidationError('分页游标位置无效');
  }
  if (query.status !== undefined && query.status !== cursor.s) {
    throw new ValidationError('分页筛选条件不一致');
  }

  const repeatsTime = query.createdFrom !== undefined || query.createdBefore !== undefined;
  if (repeatsTime) {
    if (query.createdFrom === undefined || query.createdBefore === undefined) {
      throw new ValidationError('时间范围必须同时提供起止时间');
    }
    if (
      parseTimestamp(query.createdFrom).getTime() !== createdFrom.getTime() ||
      parseTimestamp(query.createdBefore).getTime() !== createdBefore.getTime()
    ) {
      throw new ValidationError('分页时间范围不一致');
    }
  }

  return {
    status: cursor.s,
    createdFrom,
    createdBefore,
    mode: cursor.m,
    cursor: { createdAt: lastCreatedAt, id: cursor.i },
    filterCategory: filterCategory(cursor.s, cursor.m === 'e'),
  };
}

function validateWindow(from: Date, before: Date, observedAt: Date): void {
  const duration = before.getTime() - from.getTime();
  if (duration <= 0 || duration > MAX_WINDOW_MS || before.getTime() > observedAt.getTime()) {
    throw new ValidationError('时间范围无效');
  }
}

function filterCategory(
  status: AdminAiTurnStatus | null,
  explicitTime: boolean,
): NormalizedTurnRead['filterCategory'] {
  if (status && explicitTime) return 'status_and_time';
  if (status) return 'status';
  if (explicitTime) return 'time_range';
  return 'all';
}

function parseTimestamp(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new ValidationError('时间格式无效');
  return parsed;
}

function encodeCursor(cursor: AdminAiTurnMetadataCursor): string {
  const encoded = encodeOpaqueCursor(adminAiTurnMetadataCursorSchema.parse(cursor));
  if (encoded.length > MAX_CURSOR_LENGTH) {
    throw new Error('Generated AI Turn metadata cursor exceeded its public bound');
  }
  return encoded;
}
