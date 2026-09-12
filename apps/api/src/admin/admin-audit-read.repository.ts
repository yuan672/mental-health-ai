import {
  and,
  auditLogs,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lt,
  or,
  type AppTransaction,
} from '@mental-health/database';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type {
  ReadableAuditAction,
  ReadableAuditResourceType,
  StoredAuditReadRow,
} from './admin-audit-read.schemas';

export type AdminAuditReadCursorPosition = Readonly<{
  occurredAt: Date;
  id: string;
}>;

export type AdminAuditReadRepositoryQuery = Readonly<{
  readableActions: readonly ReadableAuditAction[];
  action: ReadableAuditAction | null;
  resourceType: ReadableAuditResourceType | null;
  occurredFrom: Date;
  occurredBefore: Date;
  observedAt: Date;
  cursor: AdminAuditReadCursorPosition | null;
  limit: number;
}>;

@Injectable()
export class AdminAuditReadRepository {
  constructor(private readonly database: DatabaseService) {}

  readTransaction<T>(work: (tx: AppTransaction) => Promise<T>): Promise<T> {
    return this.database.database.transaction(work, {
      isolationLevel: 'repeatable read',
      accessMode: 'read write',
    });
  }

  list(tx: AppTransaction, input: AdminAuditReadRepositoryQuery): Promise<StoredAuditReadRow[]> {
    const cursorPredicate = input.cursor
      ? or(
          lt(auditLogs.occurredAt, input.cursor.occurredAt),
          and(eq(auditLogs.occurredAt, input.cursor.occurredAt), lt(auditLogs.id, input.cursor.id)),
        )
      : undefined;

    return tx
      .select({
        id: auditLogs.id,
        actorType: auditLogs.actorType,
        actorId: auditLogs.actorId,
        action: auditLogs.action,
        resourceType: auditLogs.resourceType,
        resourceId: auditLogs.resourceId,
        occurredAt: auditLogs.occurredAt,
        safeMetadata: auditLogs.safeMetadata,
        retentionUntil: auditLogs.retentionUntil,
      })
      .from(auditLogs)
      .where(
        and(
          inArray(auditLogs.action, [...input.readableActions]),
          input.action ? eq(auditLogs.action, input.action) : undefined,
          input.resourceType ? eq(auditLogs.resourceType, input.resourceType) : undefined,
          gte(auditLogs.occurredAt, input.occurredFrom),
          lt(auditLogs.occurredAt, input.occurredBefore),
          gt(auditLogs.retentionUntil, input.observedAt),
          cursorPredicate,
        ),
      )
      .orderBy(desc(auditLogs.occurredAt), desc(auditLogs.id))
      .limit(input.limit);
  }
}
