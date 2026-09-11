import { randomUUID } from 'node:crypto';
import {
  and,
  consentDecisions,
  consents,
  desc,
  eq,
  inArray,
  lt,
  or,
  sql,
  users,
  type AppDatabase,
  type AppTransaction,
  type ConsentDecision,
  type ConsentDecisionOutcome,
  type ConsentDecisionSource,
  type ConsentStatus,
} from '@mental-health/database';
import type { ConsentMutationRequest } from '@mental-health/types';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export type ConsentProjectionRecord = {
  id: string;
  userId: string;
  consentType: string;
  consentVersion: string;
  status: ConsentStatus;
  acceptedAt: Date;
  withdrawnAt: Date | null;
  stateRevision: number;
  effectiveAt: Date;
};

export type ConsentDecisionRecord = {
  id: string;
  consentId: string;
  userId: string;
  consentType: string;
  consentVersion: string;
  operationId: string;
  decision: ConsentDecision;
  outcome: ConsentDecisionOutcome;
  priorRevision: number;
  resultingRevision: number;
  occurredAt: Date;
  documentKey: string | null;
  documentRevision: string | null;
  targetAcceptanceDecisionId: string | null;
  targetDocumentKey: string | null;
  targetDocumentRevision: string | null;
  decisionSource: ConsentDecisionSource;
};

export type ConsentDecisionCursor = Readonly<{ occurredAt: Date; id: string }>;

type RawConsentDecisionRecord = Omit<
  ConsentDecisionRecord,
  'decision' | 'outcome' | 'decisionSource' | 'targetDocumentKey' | 'targetDocumentRevision'
> & {
  decision: string;
  outcome: string;
  decisionSource: string;
};

export class ConsentOperationConflictRepositoryError extends Error {}
export class ConsentDocumentIdentityConflictRepositoryError extends Error {}
export class ConsentStateChangedRepositoryError extends Error {}
export class ConsentTargetInvalidRepositoryError extends Error {}

function projectionSelection() {
  return {
    id: consents.id,
    userId: consents.userId,
    consentType: consents.consentType,
    consentVersion: consents.consentVersion,
    status: consents.status,
    acceptedAt: consents.acceptedAt,
    withdrawnAt: consents.withdrawnAt,
    stateRevision: consents.stateRevision,
    effectiveAt: consents.effectiveAt,
  };
}

function decisionSelection() {
  return {
    id: consentDecisions.id,
    consentId: consentDecisions.consentId,
    userId: consentDecisions.userId,
    consentType: consentDecisions.consentType,
    consentVersion: consentDecisions.consentVersion,
    operationId: consentDecisions.operationId,
    decision: consentDecisions.decision,
    outcome: consentDecisions.outcome,
    priorRevision: consentDecisions.priorRevision,
    resultingRevision: consentDecisions.resultingRevision,
    occurredAt: consentDecisions.occurredAt,
    documentKey: consentDecisions.documentKey,
    documentRevision: consentDecisions.documentRevision,
    targetAcceptanceDecisionId: consentDecisions.targetAcceptanceDecisionId,
    decisionSource: consentDecisions.decisionSource,
  };
}

function isDecision(value: string): value is ConsentDecision {
  return value === 'accepted' || value === 'withdrawn';
}

function isOutcome(value: string): value is ConsentDecisionOutcome {
  return value === 'applied' || value === 'no_change';
}

function isSource(value: string): value is ConsentDecisionSource {
  return value === 'registration' || value === 'privacy_ui' || value === 'legacy_backfill';
}

@Injectable()
export class ConsentLifecycleRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async findProjection(
    userId: string,
    consentType: string,
    consentVersion: string,
  ): Promise<ConsentProjectionRecord | null> {
    const [record] = await this.databaseService.database
      .select(projectionSelection())
      .from(consents)
      .where(
        and(
          eq(consents.userId, userId),
          eq(consents.consentType, consentType),
          eq(consents.consentVersion, consentVersion),
        ),
      )
      .limit(1);
    return record ?? null;
  }

  listProjections(userId: string): Promise<ConsentProjectionRecord[]> {
    return this.databaseService.database
      .select(projectionSelection())
      .from(consents)
      .where(eq(consents.userId, userId));
  }

  async findOperation(userId: string, operationId: string): Promise<ConsentDecisionRecord | null> {
    const row = await this.findOperationWith(this.databaseService.database, userId, operationId);
    return row ? this.hydrateTarget(this.databaseService.database, row) : null;
  }

  async resolveCommittedOperation(
    userId: string,
    input: ConsentMutationRequest,
    deadlineAt: Date,
  ): Promise<{
    receipt: ConsentDecisionRecord;
    current: ConsentProjectionRecord;
    replayed: true;
  } | null> {
    return this.databaseService.database.transaction(async (transaction) => {
      const remainingMs = deadlineAt.getTime() - Date.now();
      if (remainingMs <= 0) {
        throw new Error('consent_reconciliation_deadline_exceeded');
      }
      const databaseTimeout = `${remainingMs}ms`;
      await transaction.execute(
        sql`SELECT set_config('lock_timeout', ${databaseTimeout}, true), set_config('statement_timeout', ${databaseTimeout}, true)`,
      );

      // The mutation transaction locks the same owner row before committing. Waiting
      // on that lock distinguishes a confirmed rollback from a commit whose client
      // acknowledgement was lost; a plain MVCC read could observe the old snapshot.
      const [owner] = await transaction
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
        .for('update');
      if (!owner) return null;

      const row = await this.findOperationWith(transaction, userId, input.operationId);
      if (!row) return null;
      this.assertReplayMatches(row, input);
      const [current] = await transaction
        .select(projectionSelection())
        .from(consents)
        .where(eq(consents.id, row.consentId))
        .limit(1);
      if (!current) {
        throw new ConsentTargetInvalidRepositoryError();
      }
      return {
        receipt: await this.hydrateTarget(transaction, row),
        current,
        replayed: true,
      };
    });
  }

  async findWithdrawalDependency(
    userId: string,
    input: Extract<ConsentMutationRequest, { action: 'withdraw' }>,
  ): Promise<ConsentDecisionRecord | null> {
    const projection = await this.findProjection(userId, input.consentType, input.consentVersion);
    if (!projection || projection.stateRevision !== input.expectedRevision) return null;
    return this.findEffectiveAcceptance(userId, input.consentType, input.consentVersion);
  }

  assertOperationMatches(record: ConsentDecisionRecord, input: ConsentMutationRequest): void {
    this.assertReplayMatches(record, input);
  }

  async listDecisionHistoryPage(
    userId: string,
    consentTypes: readonly [string, ...string[]],
    limit: number,
    cursor: ConsentDecisionCursor | null,
  ): Promise<ConsentDecisionRecord[]> {
    const cursorPredicate = cursor
      ? or(
          lt(consentDecisions.occurredAt, cursor.occurredAt),
          and(
            eq(consentDecisions.occurredAt, cursor.occurredAt),
            lt(consentDecisions.id, cursor.id),
          ),
        )
      : undefined;
    const rows = await this.databaseService.database
      .select(decisionSelection())
      .from(consentDecisions)
      .where(
        and(
          eq(consentDecisions.userId, userId),
          inArray(consentDecisions.consentType, [...consentTypes]),
          cursorPredicate,
        ),
      )
      .orderBy(desc(consentDecisions.occurredAt), desc(consentDecisions.id))
      .limit(limit);
    return Promise.all(rows.map((row) => this.hydrateTarget(this.databaseService.database, row)));
  }

  async findEffectiveAcceptance(
    userId: string,
    consentType: string,
    consentVersion: string,
  ): Promise<ConsentDecisionRecord | null> {
    const [row] = await this.databaseService.database
      .select(decisionSelection())
      .from(consentDecisions)
      .where(
        and(
          eq(consentDecisions.userId, userId),
          eq(consentDecisions.consentType, consentType),
          eq(consentDecisions.consentVersion, consentVersion),
          eq(consentDecisions.decision, 'accepted'),
          eq(consentDecisions.outcome, 'applied'),
        ),
      )
      .orderBy(desc(consentDecisions.resultingRevision))
      .limit(1);
    return row ? this.hydrateTarget(this.databaseService.database, row) : null;
  }

  async mutate(
    userId: string,
    input: ConsentMutationRequest,
    now = new Date(),
  ): Promise<{
    receipt: ConsentDecisionRecord;
    current: ConsentProjectionRecord;
    replayed: boolean;
  }> {
    return this.databaseService.database.transaction(async (transaction) => {
      const beforeLock = await this.findOperationWith(transaction, userId, input.operationId);
      if (beforeLock) {
        this.assertReplayMatches(beforeLock, input);
        return this.replayResult(transaction, beforeLock);
      }

      const [owner] = await transaction
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
        .for('update');
      if (!owner) {
        throw new ConsentTargetInvalidRepositoryError();
      }

      const concurrentWinner = await this.findOperationWith(transaction, userId, input.operationId);
      if (concurrentWinner) {
        this.assertReplayMatches(concurrentWinner, input);
        return this.replayResult(transaction, concurrentWinner);
      }

      const [projection] = await transaction
        .select(projectionSelection())
        .from(consents)
        .where(
          and(
            eq(consents.userId, userId),
            eq(consents.consentType, input.consentType),
            eq(consents.consentVersion, input.consentVersion),
          ),
        )
        .limit(1)
        .for('update');

      if (!projection) {
        if (input.action !== 'accept' || input.expectedRevision !== 0) {
          throw new ConsentStateChangedRepositoryError();
        }
        return this.insertFirstAcceptance(transaction, userId, input, now);
      }
      if (projection.stateRevision !== input.expectedRevision) {
        throw new ConsentStateChangedRepositoryError();
      }
      return input.action === 'accept'
        ? this.applyAcceptance(transaction, projection, input, now)
        : this.applyWithdrawal(transaction, projection, input, now);
    });
  }

  private async insertFirstAcceptance(
    transaction: AppTransaction,
    userId: string,
    input: Extract<ConsentMutationRequest, { action: 'accept' }>,
    now: Date,
  ) {
    const projection: ConsentProjectionRecord = {
      id: randomUUID(),
      userId,
      consentType: input.consentType,
      consentVersion: input.consentVersion,
      status: 'accepted',
      acceptedAt: now,
      withdrawnAt: null,
      stateRevision: 1,
      effectiveAt: now,
    };
    await transaction.insert(consents).values(projection);
    const receipt = await this.insertDecision(transaction, {
      projection,
      operationId: input.operationId,
      decision: 'accepted',
      outcome: 'applied',
      priorRevision: 0,
      resultingRevision: 1,
      occurredAt: now,
      documentKey: input.documentKey,
      documentRevision: input.documentRevision,
      targetAcceptanceDecisionId: null,
      decisionSource: 'privacy_ui',
    });
    return { receipt, current: projection, replayed: false };
  }

  private async applyAcceptance(
    transaction: AppTransaction,
    projection: ConsentProjectionRecord,
    input: Extract<ConsentMutationRequest, { action: 'accept' }>,
    now: Date,
  ) {
    const effective = await this.findLatestAppliedAcceptance(transaction, projection);
    if (
      effective &&
      effective.documentKey !== null &&
      effective.documentRevision !== null &&
      (effective.documentKey !== input.documentKey ||
        effective.documentRevision !== input.documentRevision)
    ) {
      throw new ConsentDocumentIdentityConflictRepositoryError();
    }
    const noChange =
      projection.status === 'accepted' &&
      effective?.documentKey === input.documentKey &&
      effective.documentRevision === input.documentRevision;
    const nextRevision = noChange ? projection.stateRevision : projection.stateRevision + 1;
    const receipt = await this.insertDecision(transaction, {
      projection,
      operationId: input.operationId,
      decision: 'accepted',
      outcome: noChange ? 'no_change' : 'applied',
      priorRevision: projection.stateRevision,
      resultingRevision: nextRevision,
      occurredAt: now,
      documentKey: input.documentKey,
      documentRevision: input.documentRevision,
      targetAcceptanceDecisionId: null,
      decisionSource: 'privacy_ui',
    });
    if (noChange) {
      return { receipt, current: projection, replayed: false };
    }
    const current = {
      ...projection,
      status: 'accepted' as const,
      acceptedAt: now,
      withdrawnAt: null,
      stateRevision: nextRevision,
      effectiveAt: now,
    };
    await transaction
      .update(consents)
      .set({
        status: current.status,
        acceptedAt: current.acceptedAt,
        withdrawnAt: current.withdrawnAt,
        stateRevision: current.stateRevision,
        effectiveAt: current.effectiveAt,
      })
      .where(eq(consents.id, projection.id));
    return { receipt, current, replayed: false };
  }

  private async applyWithdrawal(
    transaction: AppTransaction,
    projection: ConsentProjectionRecord,
    input: Extract<ConsentMutationRequest, { action: 'withdraw' }>,
    now: Date,
  ) {
    const target = await this.findLatestAppliedAcceptance(transaction, projection);
    if (!target || target.decision !== 'accepted' || target.outcome !== 'applied') {
      throw new ConsentTargetInvalidRepositoryError();
    }
    const noChange = projection.status === 'withdrawn';
    const nextRevision = noChange ? projection.stateRevision : projection.stateRevision + 1;
    const receipt = await this.insertDecision(transaction, {
      projection,
      operationId: input.operationId,
      decision: 'withdrawn',
      outcome: noChange ? 'no_change' : 'applied',
      priorRevision: projection.stateRevision,
      resultingRevision: nextRevision,
      occurredAt: now,
      documentKey: null,
      documentRevision: null,
      targetAcceptanceDecisionId: target.id,
      decisionSource: 'privacy_ui',
    });
    if (noChange) {
      return { receipt, current: projection, replayed: false };
    }
    const current = {
      ...projection,
      status: 'withdrawn' as const,
      withdrawnAt: now,
      stateRevision: nextRevision,
      effectiveAt: now,
    };
    await transaction
      .update(consents)
      .set({
        status: current.status,
        withdrawnAt: current.withdrawnAt,
        stateRevision: current.stateRevision,
        effectiveAt: current.effectiveAt,
      })
      .where(eq(consents.id, projection.id));
    return { receipt, current, replayed: false };
  }

  private async insertDecision(
    transaction: AppTransaction,
    input: {
      projection: ConsentProjectionRecord;
      operationId: string;
      decision: ConsentDecision;
      outcome: ConsentDecisionOutcome;
      priorRevision: number;
      resultingRevision: number;
      occurredAt: Date;
      documentKey: string | null;
      documentRevision: string | null;
      targetAcceptanceDecisionId: string | null;
      decisionSource: ConsentDecisionSource;
    },
  ): Promise<ConsentDecisionRecord> {
    const [row] = await transaction
      .insert(consentDecisions)
      .values({
        id: randomUUID(),
        consentId: input.projection.id,
        userId: input.projection.userId,
        consentType: input.projection.consentType,
        consentVersion: input.projection.consentVersion,
        operationId: input.operationId,
        decision: input.decision,
        outcome: input.outcome,
        priorRevision: input.priorRevision,
        resultingRevision: input.resultingRevision,
        occurredAt: input.occurredAt,
        documentKey: input.documentKey,
        documentRevision: input.documentRevision,
        targetAcceptanceDecisionId: input.targetAcceptanceDecisionId,
        decisionSource: input.decisionSource,
      })
      .returning(decisionSelection());
    if (!row) {
      throw new Error('Consent decision insert returned no record');
    }
    const target = input.targetAcceptanceDecisionId
      ? await this.findDecisionById(transaction, input.targetAcceptanceDecisionId)
      : null;
    return this.normalizeDecision(row, target);
  }

  private async findOperationWith(
    database: AppDatabase | AppTransaction,
    userId: string,
    operationId: string,
  ): Promise<RawConsentDecisionRecord | null> {
    const [row] = await database
      .select(decisionSelection())
      .from(consentDecisions)
      .where(
        and(eq(consentDecisions.userId, userId), eq(consentDecisions.operationId, operationId)),
      )
      .limit(1);
    return row ?? null;
  }

  private async findDecisionById(database: AppDatabase | AppTransaction, id: string) {
    const [row] = await database
      .select(decisionSelection())
      .from(consentDecisions)
      .where(eq(consentDecisions.id, id))
      .limit(1);
    return row ?? null;
  }

  private async findLatestAppliedAcceptance(
    transaction: AppTransaction,
    projection: ConsentProjectionRecord,
  ) {
    const [row] = await transaction
      .select(decisionSelection())
      .from(consentDecisions)
      .where(
        and(
          eq(consentDecisions.consentId, projection.id),
          eq(consentDecisions.decision, 'accepted'),
          eq(consentDecisions.outcome, 'applied'),
        ),
      )
      .orderBy(desc(consentDecisions.resultingRevision))
      .limit(1);
    return row ?? null;
  }

  private async hydrateTarget(
    database: AppDatabase | AppTransaction,
    row: RawConsentDecisionRecord,
  ): Promise<ConsentDecisionRecord> {
    const target = row.targetAcceptanceDecisionId
      ? await this.findDecisionById(database, row.targetAcceptanceDecisionId)
      : null;
    return this.normalizeDecision(row, target);
  }

  private normalizeDecision(
    row: RawConsentDecisionRecord,
    target: { documentKey: string | null; documentRevision: string | null } | null,
  ): ConsentDecisionRecord {
    if (!isDecision(row.decision) || !isOutcome(row.outcome) || !isSource(row.decisionSource)) {
      throw new Error('Consent decision contains an unsupported bounded value');
    }
    return {
      ...row,
      decision: row.decision,
      outcome: row.outcome,
      decisionSource: row.decisionSource,
      targetDocumentKey: target?.documentKey ?? null,
      targetDocumentRevision: target?.documentRevision ?? null,
    };
  }

  private assertReplayMatches(
    row: {
      decision: string;
      consentType: string;
      consentVersion: string;
      priorRevision: number;
      documentKey: string | null;
      documentRevision: string | null;
    },
    input: ConsentMutationRequest,
  ): void {
    const expectedDecision = input.action === 'accept' ? 'accepted' : 'withdrawn';
    const commonMatches =
      row.decision === expectedDecision &&
      row.consentType === input.consentType &&
      row.consentVersion === input.consentVersion &&
      row.priorRevision === input.expectedRevision;
    const documentMatches =
      input.action === 'withdraw' ||
      (row.documentKey === input.documentKey && row.documentRevision === input.documentRevision);
    if (!commonMatches || !documentMatches) {
      throw new ConsentOperationConflictRepositoryError();
    }
  }

  private async replayResult(transaction: AppTransaction, row: RawConsentDecisionRecord) {
    const [current] = await transaction
      .select(projectionSelection())
      .from(consents)
      .where(eq(consents.id, row.consentId))
      .limit(1);
    if (!current) {
      throw new ConsentTargetInvalidRepositoryError();
    }
    return {
      receipt: await this.hydrateTarget(transaction, row),
      current,
      replayed: true,
    };
  }
}
