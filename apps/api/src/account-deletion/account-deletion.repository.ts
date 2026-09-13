import {
  and,
  auditLogs,
  eq,
  passwordCredentials,
  sessions,
  sql,
  users,
} from '@mental-health/database';
import { Inject, Injectable } from '@nestjs/common';
import type { SessionRecord } from '../users/users.repository';
import { DatabaseService } from '../database/database.service';
import { AuditLogRepository } from '../safety/audit/audit-log.repository';

export const ACCOUNT_DELETION_REPOSITORY_HOOKS = Symbol('ACCOUNT_DELETION_REPOSITORY_HOOKS');

export type AccountDeletionRepositoryHooks = Readonly<{
  afterCommitted?: (input: { userId: string; operationId: string }) => void | Promise<void>;
  afterUserLocked?: (input: { transactionStartedAt: Date }) => void | Promise<void>;
  afterSessionValidated?: () => void | Promise<void>;
  afterRequiredAuditInserted?: () => void | Promise<void>;
  whileConfirmationUserLockPending?: () => void | Promise<void>;
}>;

export class AccountDeletionRepositoryPreconditionError extends Error {
  constructor(public readonly reason: 'user_missing' | 'session_invalid' | 'audit_conflict') {
    super(`Account deletion precondition failed: ${reason}`);
    this.name = AccountDeletionRepositoryPreconditionError.name;
  }
}

export class AccountDeletionRepositoryInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = AccountDeletionRepositoryInvariantError.name;
  }
}

export type AccountDeletionConfirmation =
  | Readonly<{ status: 'committed' }>
  | Readonly<{ status: 'rolled_back' }>
  | Readonly<{ status: 'conflict' }>
  | Readonly<{ status: 'unknown' }>;

@Injectable()
export class AccountDeletionRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly audits: AuditLogRepository,
    @Inject(ACCOUNT_DELETION_REPOSITORY_HOOKS)
    private readonly hooks: AccountDeletionRepositoryHooks,
  ) {}

  async findPasswordCredential(userId: string): Promise<{ passwordHash: string } | null> {
    const [credential] = await this.database.database
      .select({ passwordHash: passwordCredentials.passwordHash })
      .from(passwordCredentials)
      .where(eq(passwordCredentials.userId, userId))
      .limit(1);
    return credential ?? null;
  }

  async deleteAccount(input: {
    userId: string;
    session: SessionRecord;
    operationId: string;
    deadlineAt: Date;
    assertMayStartMutation: () => void;
    onRequiredAuditInserted: () => void;
  }): Promise<void> {
    const idempotencyKey = this.auditKey(input.operationId);
    await this.database.database.transaction(async (transaction) => {
      await this.setTimeouts(transaction, input.deadlineAt);
      const [owner] = await transaction
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1)
        .for('update');
      if (!owner) throw new AccountDeletionRepositoryPreconditionError('user_missing');
      if (this.hooks.afterUserLocked) {
        await this.hooks.afterUserLocked({
          transactionStartedAt: await this.transactionStartedAt(transaction),
        });
      }

      const [session] = await transaction
        .select({
          id: sessions.id,
          userId: sessions.userId,
          expiresAt: sessions.expiresAt,
          revokedAt: sessions.revokedAt,
        })
        .from(sessions)
        .where(and(eq(sessions.id, input.session.id), eq(sessions.userId, input.userId)))
        .limit(1)
        .for('update');
      const observedAt = await this.observedAt(transaction);
      if (
        !session ||
        session.revokedAt !== null ||
        session.expiresAt.getTime() <= observedAt.getTime()
      ) {
        throw new AccountDeletionRepositoryPreconditionError('session_invalid');
      }
      await this.hooks.afterSessionValidated?.();

      const [existingAudit] = await transaction
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(eq(auditLogs.idempotencyKey, idempotencyKey))
        .limit(1)
        .for('update');
      if (existingAudit) throw new AccountDeletionRepositoryPreconditionError('audit_conflict');

      input.assertMayStartMutation();
      await this.audits.appendRequiredWithinTransaction(transaction, {
        actorType: 'user',
        actorId: null,
        action: 'account_deleted',
        resourceType: 'account_deletion',
        resourceId: input.operationId,
        idempotencyKey,
        safeMetadata: { initiator: 'self_service' },
        occurredAt: observedAt,
      });
      input.onRequiredAuditInserted();
      await this.hooks.afterRequiredAuditInserted?.();

      const deleted = await transaction
        .delete(users)
        .where(eq(users.id, input.userId))
        .returning({ id: users.id });
      if (deleted.length !== 1) {
        throw new AccountDeletionRepositoryInvariantError(
          'Account deletion did not remove exactly one User',
        );
      }
    });
    await this.hooks.afterCommitted?.({
      userId: input.userId,
      operationId: input.operationId,
    });
  }

  async confirmResult(input: {
    userId: string;
    operationId: string;
    ownAuditInserted: boolean;
    deadlineAt: Date;
  }): Promise<AccountDeletionConfirmation> {
    const idempotencyKey = this.auditKey(input.operationId);
    return this.database.database.transaction(async (transaction) => {
      await this.setTimeouts(transaction, input.deadlineAt);
      const ownerPromise = (async () =>
        transaction
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, input.userId))
          .limit(1)
          .for('update'))();
      await this.hooks.whileConfirmationUserLockPending?.();
      const [owner] = await ownerPromise;
      const [audit] = await transaction
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(eq(auditLogs.idempotencyKey, idempotencyKey))
        .limit(1)
        .for('update');

      if (!owner && audit && input.ownAuditInserted) return { status: 'committed' };
      if (owner && !audit) return { status: 'rolled_back' };
      if (audit && !input.ownAuditInserted) return { status: 'conflict' };
      return { status: 'unknown' };
    });
  }

  private auditKey(operationId: string): string {
    return `account-deleted:${operationId}`;
  }

  private async setTimeouts(
    transaction: Parameters<Parameters<typeof this.database.database.transaction>[0]>[0],
    deadlineAt: Date,
  ): Promise<void> {
    const remainingMs = deadlineAt.getTime() - Date.now();
    if (remainingMs <= 0) throw new Error('account_deletion_deadline_exceeded');
    const timeout = `${remainingMs}ms`;
    await transaction.execute(
      sql`SELECT set_config('lock_timeout', ${timeout}, true), set_config('statement_timeout', ${timeout}, true)`,
    );
  }

  private async observedAt(
    transaction: Parameters<Parameters<typeof this.database.database.transaction>[0]>[0],
  ): Promise<Date> {
    const result = await transaction.execute(sql`SELECT clock_timestamp() AS observed_at`);
    const row = result.rows[0] as { observed_at?: Date | string } | undefined;
    if (!row?.observed_at) throw new Error('database_observation_time_missing');
    return row.observed_at instanceof Date ? row.observed_at : new Date(row.observed_at);
  }

  private async transactionStartedAt(
    transaction: Parameters<Parameters<typeof this.database.database.transaction>[0]>[0],
  ): Promise<Date> {
    const result = await transaction.execute(
      sql`SELECT transaction_timestamp() AS transaction_started_at`,
    );
    const row = result.rows[0] as { transaction_started_at?: Date | string } | undefined;
    if (!row?.transaction_started_at) throw new Error('database_transaction_time_missing');
    return row.transaction_started_at instanceof Date
      ? row.transaction_started_at
      : new Date(row.transaction_started_at);
  }
}
