import { randomUUID } from 'node:crypto';
import { auditLogs, eq, lte, type AppTransaction } from '@mental-health/database';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { AuditRetentionPolicy } from '../persistence/safety-retention.policy';
import {
  auditActionSchema,
  auditActorTypeSchema,
  auditResourceTypeSchema,
  parseAuditMetadata,
  type AuditAction,
  type AuditActorType,
  type AuditResourceType,
} from './audit.types';

export type AppendAuditInput = Readonly<{
  actorType: AuditActorType;
  actorId: string | null;
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId: string;
  idempotencyKey: string;
  safeMetadata: unknown;
  occurredAt: Date;
}>;

@Injectable()
export class AuditLogRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly retention: AuditRetentionPolicy,
  ) {}

  appendWithinTransaction(transaction: AppTransaction, input: AppendAuditInput): Promise<unknown> {
    return transaction
      .insert(auditLogs)
      .values(this.values(input))
      .onConflictDoNothing({ target: auditLogs.idempotencyKey });
  }

  async appendRequiredWithinTransaction(
    transaction: AppTransaction,
    input: AppendAuditInput,
  ): Promise<void> {
    const inserted = await transaction
      .insert(auditLogs)
      .values(this.values(input))
      .onConflictDoNothing({ target: auditLogs.idempotencyKey })
      .returning({ id: auditLogs.id });
    if (inserted.length !== 1) {
      throw new Error('Required access audit was not inserted');
    }
  }

  async append(input: AppendAuditInput): Promise<void> {
    await this.database.database.transaction(async (transaction) => {
      await this.appendWithinTransaction(transaction, input);
    });
  }

  async purgeExpired(now: Date, batchSize: number): Promise<number> {
    const candidates = await this.database.database
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(lte(auditLogs.retentionUntil, now))
      .limit(batchSize);
    if (candidates.length === 0) return 0;
    let deleted = 0;
    await this.database.database.transaction(async (transaction) => {
      for (const candidate of candidates) {
        const rows = await transaction
          .delete(auditLogs)
          .where(eq(auditLogs.id, candidate.id))
          .returning({ id: auditLogs.id });
        deleted += rows.length;
      }
    });
    return deleted;
  }

  private values(input: AppendAuditInput): typeof auditLogs.$inferInsert {
    return {
      id: randomUUID(),
      actorType: auditActorTypeSchema.parse(input.actorType),
      actorId: input.actorId,
      action: auditActionSchema.parse(input.action),
      resourceType: auditResourceTypeSchema.parse(input.resourceType),
      resourceId: input.resourceId,
      idempotencyKey: input.idempotencyKey,
      occurredAt: input.occurredAt,
      safeMetadata: parseAuditMetadata(input.action, input.safeMetadata),
      retentionUntil: this.retention.getRetentionUntil(input.occurredAt),
    };
  }
}
