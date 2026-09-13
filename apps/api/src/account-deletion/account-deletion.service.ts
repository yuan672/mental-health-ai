import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PASSWORD_HASH_VERIFIER, type PasswordHashVerifier } from '../auth/password-hasher.service';
import type { SessionRecord } from '../users/users.repository';
import {
  AccountDeletionDisabledError,
  AccountDeletionInProgressError,
  AccountDeletionOperationConflictError,
  AccountDeletionResultUnknownError,
  AuthenticationError,
  DatabaseError,
  InvalidCredentialsError,
  RateLimitError,
} from '../common/errors';
import { AppError } from '../common/errors/app-error';
import { ERROR_CODES } from '../common/errors/error-code';
import { env } from '../config/env';
import {
  AccountTerminationCapacityError,
  ConsentExecutionCoordinator,
  type AccountTerminationCoordinationOutcome,
} from '../consents/runtime/consent-execution.coordinator';
import type { AccountDeletionRequest } from './account-deletion.schemas';
import {
  AccountDeletionRepository,
  AccountDeletionRepositoryPreconditionError,
} from './account-deletion.repository';

type Attempt = {
  readonly userId: string;
  readonly operationId: string;
  readonly token: string;
  mutationStarted: boolean;
  terminalInstalled: boolean;
  ownAuditInserted: boolean;
  run: Promise<void> | null;
};

@Injectable()
export class AccountDeletionService {
  private readonly byUser = new Map<string, Attempt>();
  private readonly byOperation = new Map<string, Attempt>();

  constructor(
    private readonly repository: AccountDeletionRepository,
    @Inject(PASSWORD_HASH_VERIFIER)
    private readonly passwordHasher: PasswordHashVerifier,
    private readonly consentExecutions: ConsentExecutionCoordinator,
  ) {}

  async deleteCurrentAccount(input: {
    session: SessionRecord;
    request: AccountDeletionRequest;
    signal: AbortSignal;
    deadlineAt: Date;
  }): Promise<void> {
    this.assertEnabled();
    let credential: { passwordHash: string } | null;
    try {
      credential = await this.repository.findPasswordCredential(input.session.userId);
    } catch {
      throw new DatabaseError();
    }
    if (!credential) throw new AuthenticationError('登录已失效，请重新登录');
    const valid = await this.passwordHasher.verify(
      credential.passwordHash,
      input.request.currentPassword,
      input.signal,
    );
    if (!valid) throw new InvalidCredentialsError();
    if (input.signal.aborted) throw input.signal.reason;

    const attempt = this.reserve(input.session.userId, input.request.operationId);
    return this.run(attempt, input.session, input.signal, input.deadlineAt);
  }

  diagnostics(): Readonly<{ unresolved: number; users: number }> {
    return { unresolved: this.byOperation.size, users: this.byUser.size };
  }

  private reserve(userId: string, operationId: string): Attempt {
    const operation = this.byOperation.get(operationId);
    if (operation) {
      if (operation.userId !== userId) throw new AccountDeletionOperationConflictError();
      return operation;
    }
    if (this.byUser.has(userId)) throw new AccountDeletionInProgressError();
    if (this.byOperation.size >= env.ACCOUNT_DELETION_MAX_UNRESOLVED_GLOBAL) {
      throw new RateLimitError('账号删除操作容量已满，请稍后重试');
    }
    const attempt: Attempt = {
      userId,
      operationId,
      token: randomUUID(),
      mutationStarted: false,
      terminalInstalled: false,
      ownAuditInserted: false,
      run: null,
    };
    this.byUser.set(userId, attempt);
    this.byOperation.set(operationId, attempt);
    return attempt;
  }

  private async run(
    attempt: Attempt,
    session: SessionRecord,
    signal: AbortSignal,
    deadlineAt: Date,
  ): Promise<void> {
    if (attempt.run) return this.waitFor(attempt, attempt.run, signal);
    const currentRun = this.perform(attempt, session, signal, deadlineAt);
    attempt.run = currentRun;
    void currentRun
      .finally(() => {
        if (attempt.run === currentRun) attempt.run = null;
      })
      .catch(() => undefined);
    await this.waitFor(attempt, currentRun, signal);
  }

  private async perform(
    attempt: Attempt,
    session: SessionRecord,
    signal: AbortSignal,
    deadlineAt: Date,
  ): Promise<void> {
    let outcome: AccountTerminationCoordinationOutcome<void>;
    try {
      outcome = await this.consentExecutions.coordinateAccountTermination(
        {
          userId: attempt.userId,
          attemptToken: attempt.token,
          signal,
          deadlineAt,
          onTerminalInstalled: () => {
            attempt.terminalInstalled = true;
          },
        },
        () => this.mutateOrConfirm(attempt, session, signal, deadlineAt),
      );
    } catch (error) {
      if (error instanceof AccountTerminationCapacityError) {
        this.release(attempt);
        throw new RateLimitError('账号删除操作容量已满，请稍后重试');
      }
      if (!attempt.mutationStarted && !attempt.terminalInstalled) this.release(attempt);
      if (attempt.mutationStarted || attempt.terminalInstalled) {
        throw new AccountDeletionResultUnknownError();
      }
      throw error;
    }

    if (outcome.status === 'committed') {
      this.release(attempt);
      return;
    }
    if (outcome.status === 'rolled_back') {
      this.release(attempt);
      this.throwConfirmedRollback(outcome.error);
    }
    throw new AccountDeletionResultUnknownError();
  }

  private async mutateOrConfirm(
    attempt: Attempt,
    session: SessionRecord,
    signal: AbortSignal,
    deadlineAt: Date,
  ): Promise<AccountTerminationCoordinationOutcome<void>> {
    if (attempt.mutationStarted) return this.confirm(attempt, deadlineAt);
    try {
      await this.repository.deleteAccount({
        userId: attempt.userId,
        session,
        operationId: attempt.operationId,
        deadlineAt,
        assertMayStartMutation: () => {
          if (signal.aborted) throw signal.reason;
          if (deadlineAt.getTime() <= Date.now())
            throw new Error('account_deletion_deadline_exceeded');
          attempt.mutationStarted = true;
        },
        onRequiredAuditInserted: () => {
          attempt.ownAuditInserted = true;
        },
      });
      return { status: 'committed', value: undefined };
    } catch (error) {
      if (!attempt.mutationStarted) return { status: 'rolled_back', error };
      return this.confirm(attempt, deadlineAt, error);
    }
  }

  private async confirm(
    attempt: Attempt,
    deadlineAt: Date,
    originalError: unknown = new Error('account_deletion_result_unknown'),
  ): Promise<AccountTerminationCoordinationOutcome<void>> {
    try {
      const confirmation = await this.repository.confirmResult({
        userId: attempt.userId,
        operationId: attempt.operationId,
        ownAuditInserted: attempt.ownAuditInserted,
        deadlineAt,
      });
      if (confirmation.status === 'committed') {
        return { status: 'committed', value: undefined };
      }
      if (confirmation.status === 'rolled_back') {
        return { status: 'rolled_back', error: originalError };
      }
      if (confirmation.status === 'conflict') {
        return {
          status: 'rolled_back',
          error: new AccountDeletionOperationConflictError(),
        };
      }
      return { status: 'unknown', error: originalError };
    } catch {
      return { status: 'unknown', error: originalError };
    }
  }

  private throwConfirmedRollback(error: unknown): never {
    if (error instanceof AccountDeletionOperationConflictError) throw error;
    if (error instanceof AccountDeletionRepositoryPreconditionError) {
      if (error.reason === 'audit_conflict') throw new AccountDeletionOperationConflictError();
      throw new AuthenticationError('登录已失效，请重新登录');
    }
    if (error instanceof InvalidCredentialsError || error instanceof AuthenticationError)
      throw error;
    throw new DatabaseError();
  }

  private waitFor(attempt: Attempt, run: Promise<void>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(this.waitError(attempt, signal));
    return new Promise<void>((resolve, reject) => {
      const aborted = () => reject(this.waitError(attempt, signal));
      signal.addEventListener('abort', aborted, { once: true });
      run.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    });
  }

  private waitError(attempt: Attempt, signal: AbortSignal): unknown {
    const reason = signal.reason ?? new Error('client_disconnect');
    if (
      (attempt.mutationStarted || attempt.terminalInstalled) &&
      reason instanceof AppError &&
      reason.code === ERROR_CODES.INTERNAL_ERROR
    ) {
      return new AccountDeletionResultUnknownError();
    }
    return reason;
  }

  private release(attempt: Attempt): void {
    if (this.byUser.get(attempt.userId) === attempt) this.byUser.delete(attempt.userId);
    if (this.byOperation.get(attempt.operationId) === attempt) {
      this.byOperation.delete(attempt.operationId);
    }
  }

  private assertEnabled(): void {
    if (
      !env.ACCOUNT_DELETION_ENABLED ||
      (env.APP_ENV !== 'development' && env.APP_ENV !== 'test')
    ) {
      throw new AccountDeletionDisabledError();
    }
  }
}
