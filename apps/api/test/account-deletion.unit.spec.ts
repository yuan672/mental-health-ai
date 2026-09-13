import type { SessionRecord } from '../src/users/users.repository';
import type { PasswordHasherService } from '../src/auth/password-hasher.service';
import type {
  AccountTerminationCoordinationOutcome,
  ConsentExecutionCoordinator,
} from '../src/consents/runtime/consent-execution.coordinator';
import {
  AccountDeletionInProgressError,
  AccountDeletionOperationConflictError,
  AccountDeletionResultUnknownError,
} from '../src/common/errors';
import type {
  AccountDeletionConfirmation,
  AccountDeletionRepository,
} from '../src/account-deletion/account-deletion.repository';
import { AccountDeletionService } from '../src/account-deletion/account-deletion.service';
import { parseAuditMetadata } from '../src/safety/audit/audit.types';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const SESSION: SessionRecord = {
  id: '33333333-3333-4333-8333-333333333333',
  userId: USER_ID,
  expiresAt: new Date(Date.now() + 60_000),
  revokedAt: null,
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function request(operationId = '44444444-4444-4444-8444-444444444444') {
  return {
    operationId,
    currentPassword: 'Synthetic-Password-9!',
    acknowledgeIrreversible: true as const,
  };
}

describe('AccountDeletionService process-bound attempts', () => {
  let confirmation: AccountDeletionConfirmation;
  let deleteCalls: number;
  let confirmCalls: number;
  let deletionBarrier: ReturnType<typeof deferred> | null;
  let mutationStarted: ReturnType<typeof deferred>;
  let deleteError: unknown;
  let repository: AccountDeletionRepository;
  let coordinator: ConsentExecutionCoordinator;
  let service: AccountDeletionService;

  beforeEach(() => {
    confirmation = { status: 'committed' };
    deleteCalls = 0;
    confirmCalls = 0;
    deletionBarrier = null;
    mutationStarted = deferred();
    deleteError = null;
    repository = {
      findPasswordCredential: () => Promise.resolve({ passwordHash: 'synthetic-hash' }),
      deleteAccount: async (input: Parameters<AccountDeletionRepository['deleteAccount']>[0]) => {
        deleteCalls += 1;
        input.assertMayStartMutation();
        mutationStarted.resolve(undefined);
        input.onRequiredAuditInserted();
        if (deletionBarrier) await deletionBarrier.promise;
        if (deleteError) throw deleteError;
      },
      confirmResult: () => {
        confirmCalls += 1;
        return Promise.resolve(confirmation);
      },
    } as unknown as AccountDeletionRepository;
    const passwordHasher = {
      verify: () => Promise.resolve(true),
    } as unknown as PasswordHasherService;
    coordinator = {
      coordinateAccountTermination: async <T>(
        _input: unknown,
        operation: () => Promise<AccountTerminationCoordinationOutcome<T>>,
      ) => operation(),
    } as ConsentExecutionCoordinator;
    service = new AccountDeletionService(repository, passwordHasher, coordinator);
  });

  it('joins twenty exact concurrent submissions to one destructive mutation', async () => {
    deletionBarrier = deferred();
    const calls = Array.from({ length: 20 }, () =>
      service.deleteCurrentAccount({
        session: SESSION,
        request: request(),
        signal: new AbortController().signal,
        deadlineAt: new Date(Date.now() + 10_000),
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    deletionBarrier.resolve(undefined);
    await expect(Promise.all(calls)).resolves.toHaveLength(20);
    expect(deleteCalls).toBe(1);
    expect(confirmCalls).toBe(0);
    expect(service.diagnostics()).toEqual({ unresolved: 0, users: 0 });
  });

  it('confirms a committed mutation after its acknowledgement is lost', async () => {
    deleteError = new Error('synthetic_commit_acknowledgement_lost');
    await expect(
      service.deleteCurrentAccount({
        session: SESSION,
        request: request(),
        signal: new AbortController().signal,
        deadlineAt: new Date(Date.now() + 10_000),
      }),
    ).resolves.toBeUndefined();
    expect(deleteCalls).toBe(1);
    expect(confirmCalls).toBe(1);
    expect(service.diagnostics()).toEqual({ unresolved: 0, users: 0 });
  });

  it('retains an unknown attempt and lets only the same operation reconcile it', async () => {
    deleteError = new Error('synthetic_commit_result_unknown');
    confirmation = { status: 'unknown' };
    await expect(
      service.deleteCurrentAccount({
        session: SESSION,
        request: request(),
        signal: new AbortController().signal,
        deadlineAt: new Date(Date.now() + 10_000),
      }),
    ).rejects.toBeInstanceOf(AccountDeletionResultUnknownError);
    expect(service.diagnostics()).toEqual({ unresolved: 1, users: 1 });

    await expect(
      service.deleteCurrentAccount({
        session: SESSION,
        request: request('55555555-5555-4555-8555-555555555555'),
        signal: new AbortController().signal,
        deadlineAt: new Date(Date.now() + 10_000),
      }),
    ).rejects.toBeInstanceOf(AccountDeletionInProgressError);
    await expect(
      service.deleteCurrentAccount({
        session: { ...SESSION, userId: OTHER_USER_ID },
        request: request(),
        signal: new AbortController().signal,
        deadlineAt: new Date(Date.now() + 10_000),
      }),
    ).rejects.toBeInstanceOf(AccountDeletionOperationConflictError);

    confirmation = { status: 'committed' };
    await expect(
      service.deleteCurrentAccount({
        session: SESSION,
        request: request(),
        signal: new AbortController().signal,
        deadlineAt: new Date(Date.now() + 10_000),
      }),
    ).resolves.toBeUndefined();
    expect(deleteCalls).toBe(1);
    expect(confirmCalls).toBe(2);
    expect(service.diagnostics()).toEqual({ unresolved: 0, users: 0 });
  });

  it('continues one server-owned mutation after the initiating client disconnects', async () => {
    deletionBarrier = deferred();
    const firstClient = new AbortController();
    const first = service.deleteCurrentAccount({
      session: SESSION,
      request: request(),
      signal: firstClient.signal,
      deadlineAt: new Date(Date.now() + 10_000),
    });
    await mutationStarted.promise;
    const joined = service.deleteCurrentAccount({
      session: SESSION,
      request: request(),
      signal: new AbortController().signal,
      deadlineAt: new Date(Date.now() + 10_000),
    });
    firstClient.abort(new Error('synthetic_client_disconnect'));
    await expect(first).rejects.toThrow('synthetic_client_disconnect');
    deletionBarrier.resolve(undefined);
    await expect(joined).resolves.toBeUndefined();
    expect(deleteCalls).toBe(1);
    expect(service.diagnostics()).toEqual({ unresolved: 0, users: 0 });
  });

  it('does not reserve or mutate when cancellation wins before the destructive boundary', async () => {
    const client = new AbortController();
    client.abort(new Error('synthetic_pre_mutation_cancel'));
    await expect(
      service.deleteCurrentAccount({
        session: SESSION,
        request: request(),
        signal: client.signal,
        deadlineAt: new Date(Date.now() + 10_000),
      }),
    ).rejects.toThrow('synthetic_pre_mutation_cancel');
    expect(deleteCalls).toBe(0);
    expect(service.diagnostics()).toEqual({ unresolved: 0, users: 0 });
  });

  it('accepts only the bounded content-free account deletion Audit metadata', () => {
    expect(parseAuditMetadata('account_deleted', { initiator: 'self_service' })).toEqual({
      initiator: 'self_service',
    });
    expect(() =>
      parseAuditMetadata('account_deleted', {
        initiator: 'self_service',
        email: 'not-allowed@example.test',
      }),
    ).toThrow();
  });
});
