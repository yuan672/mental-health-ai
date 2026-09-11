import type { IncognitoContextStore } from '../src/ai/incognito/incognito-context.store';
import {
  ActiveAiExecutionRegistry,
  AiExecutionTotalTimeoutError,
} from '../src/ai/runtime/active-ai-execution.registry';
import {
  ConsentExecutionCoordinator,
  type WithdrawnConsentDependency,
} from '../src/consents/runtime/consent-execution.coordinator';
import type { ConsentAuthorizationSnapshotPort } from '../src/consents/runtime/consent-authorization.port';
import type { ConsentDependency } from '../src/consents/runtime/consent-execution.types';
import {
  ConsentCoordinationNotStartedError,
  PerUserConsentLock,
} from '../src/consents/runtime/per-user-consent-lock';
import { env } from '../src/config/env';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';

function dependency(id: string, stateRevision: number): ConsentDependency {
  return {
    consentId: `33333333-3333-4333-8333-${id.padStart(12, '0')}`,
    acceptanceDecisionId: `44444444-4444-4444-8444-${id.padStart(12, '0')}`,
    stateRevision,
    consentType: 'privacy_policy',
    consentVersion: '1.0',
  };
}

function withdrawn(value: ConsentDependency): WithdrawnConsentDependency {
  return {
    acceptanceDecisionId: value.acceptanceDecisionId,
    consentType: value.consentType,
    consentVersion: value.consentVersion,
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class MutableAuthorization implements ConsentAuthorizationSnapshotPort {
  current: readonly ConsentDependency[];

  constructor(initial: readonly ConsentDependency[]) {
    this.current = initial;
  }

  requiredPolicyKeys() {
    return [{ consentType: 'privacy_policy' as const, consentVersion: '1.0' }];
  }

  loadRequiredDependencies(): Promise<readonly ConsentDependency[]> {
    return Promise.resolve(this.current);
  }

  dependenciesRemainActive(
    _userId: string,
    dependencies: readonly ConsentDependency[],
  ): Promise<boolean> {
    return Promise.resolve(
      dependencies.length === this.current.length &&
        dependencies.every((item) =>
          this.current.some(
            (candidate) =>
              candidate.acceptanceDecisionId === item.acceptanceDecisionId &&
              candidate.stateRevision === item.stateRevision,
          ),
        ),
    );
  }
}

class TrackingContexts {
  cleared: string[] = [];
  createCalls = 0;
  dependencies = new Set<string>();
  throwOnClear = false;

  create(): never {
    this.createCalls += 1;
    throw new Error('unexpected_context_create');
  }

  clearDependency(_userId: string, acceptanceDecisionId: string): number {
    this.cleared.push(acceptanceDecisionId);
    if (this.throwOnClear) throw new Error('synthetic_context_cleanup_failure');
    this.dependencies.delete(acceptanceDecisionId);
    return 1;
  }

  hasDependency(acceptanceDecisionId: string): boolean {
    return this.dependencies.has(acceptanceDecisionId);
  }
}

describe('Consent runtime coordination', () => {
  let active: ActiveAiExecutionRegistry;
  let authorization: MutableAuthorization;
  let contexts: TrackingContexts;
  let lock: PerUserConsentLock;
  let coordinator: ConsentExecutionCoordinator;
  const first = dependency('1', 1);

  beforeEach(() => {
    active = new ActiveAiExecutionRegistry();
    authorization = new MutableAuthorization([first]);
    contexts = new TrackingContexts();
    contexts.dependencies.add(first.acceptanceDecisionId);
    lock = new PerUserConsentLock();
    coordinator = new ConsentExecutionCoordinator(
      active,
      authorization,
      contexts as unknown as IncognitoContextStore,
      lock,
    );
  });

  afterEach(() => {
    active.onModuleDestroy();
    lock.onModuleDestroy();
  });

  async function boundExecution() {
    const pending = coordinator.registerPending({
      userId: USER_ID,
      sessionId: SESSION_ID,
      clientSignal: new AbortController().signal,
    });
    return coordinator.bindRequired(pending);
  }

  async function publish(
    value: ConsentDependency,
    invalidatePending: boolean,
    withdrawalTargetDecisionId?: string,
  ) {
    const result = { committed: true };
    return coordinator.coordinateMutation(
      {
        userId: USER_ID,
        signal: new AbortController().signal,
        deadlineAt: new Date(Date.now() + 5_000),
        mayWithdraw: true,
        operationPreviouslyCommitted: withdrawalTargetDecisionId !== undefined,
        prepareWithdrawal: () => Promise.resolve(withdrawn(value)),
        resolveCommitted: () => Promise.resolve(null),
        isDefiniteRollback: () => false,
      },
      () => Promise.resolve(result),
      () => ({ dependency: withdrawn(value), invalidatePending }),
    );
  }

  it('blocks transport dispatch when withdrawal commits first', async () => {
    const execution = await boundExecution();
    await publish(first, true);
    let starts = 0;
    await expect(
      coordinator.start(execution, 'risk_classification', () => {
        starts += 1;
        return Promise.resolve('unexpected');
      }),
    ).rejects.toBeDefined();
    expect(starts).toBe(0);
    expect(execution.signal.aborted).toBe(true);
  });

  it('releases the user lock after fetch initiation and aborts an in-flight transport', async () => {
    const execution = await boundExecution();
    const network = deferred<string>();
    const transportSignals: AbortSignal[] = [];
    const started = await coordinator.start(execution, 'generation', (signal) => {
      transportSignals.push(signal);
      return network.promise;
    });

    await publish(first, true);
    expect(transportSignals).toHaveLength(1);
    expect(transportSignals[0]?.aborted).toBe(true);
    expect(lock.diagnostics()).toEqual({ users: 0, waiters: 0 });
    network.resolve('synthetic-response');
    await expect(started.transport).resolves.toBe('synthetic-response');
  });

  it('reconciles an old withdrawal replay without invalidating a later acceptance pending bind', async () => {
    const oldExecution = await boundExecution();
    await publish(first, true);
    expect(oldExecution.signal.aborted).toBe(true);
    oldExecution.dispose();

    const second = dependency('2', 3);
    authorization.current = [second];
    contexts.dependencies.add(second.acceptanceDecisionId);
    const pending = coordinator.registerPending({
      userId: USER_ID,
      sessionId: SESSION_ID,
      clientSignal: new AbortController().signal,
    });
    await publish(first, false, first.acceptanceDecisionId);

    const rebound = await coordinator.bindRequired(pending);
    expect(rebound.dependencies).toEqual([second]);
    expect(rebound.signal.aborted).toBe(false);
    expect(contexts.cleared).toEqual([first.acceptanceDecisionId, first.acceptanceDecisionId]);
    expect(contexts.dependencies.has(second.acceptanceDecisionId)).toBe(true);
    rebound.dispose();
  });

  it('keeps a revoked marker fail closed after cleanup failure and lets exact replay reconcile it', async () => {
    contexts.throwOnClear = true;
    await expect(publish(first, true)).rejects.toThrow('synthetic_context_cleanup_failure');

    const pending = coordinator.registerPending({
      userId: USER_ID,
      sessionId: SESSION_ID,
      clientSignal: new AbortController().signal,
    });
    await expect(coordinator.bindRequired(pending)).rejects.toBeDefined();
    pending.dispose();

    contexts.throwOnClear = false;
    await expect(publish(first, false, first.acceptanceDecisionId)).resolves.toEqual({
      committed: true,
    });
    expect(lock.diagnostics()).toEqual({ users: 0, waiters: 0 });
  });

  it('does not require revoked-marker capacity for an exact target with no live references', async () => {
    const originalLimit = env.CONSENT_REVOKED_MARKER_MAX_GLOBAL;
    env.CONSENT_REVOKED_MARKER_MAX_GLOBAL = 1;
    try {
      await publish(first, true);
      const unrelated = dependency('9', 1);
      await expect(publish(unrelated, false, unrelated.acceptanceDecisionId)).resolves.toEqual({
        committed: true,
      });
    } finally {
      env.CONSENT_REVOKED_MARKER_MAX_GLOBAL = originalLimit;
    }
  });

  it('reports a definitely-not-started mutation when lock acquisition is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('synthetic_precommit_abort'));
    let commitCalls = 0;
    await expect(
      coordinator.coordinateMutation(
        {
          userId: USER_ID,
          signal: controller.signal,
          deadlineAt: new Date(Date.now() + 5_000),
          mayWithdraw: false,
          operationPreviouslyCommitted: false,
          prepareWithdrawal: () => Promise.resolve(null),
          resolveCommitted: () => Promise.resolve(null),
          isDefiniteRollback: () => false,
        },
        () => {
          commitCalls += 1;
          return Promise.resolve({ committed: true });
        },
        () => null,
      ),
    ).rejects.toBeInstanceOf(ConsentCoordinationNotStartedError);
    expect(commitCalls).toBe(0);
  });

  it('uses the canonical AI total-timeout error when lock acquisition sees an expired deadline', async () => {
    await expect(
      lock.runExclusive(
        USER_ID,
        new AbortController().signal,
        new Date(Date.now() - 1),
        () => undefined,
      ),
    ).rejects.toBeInstanceOf(AiExecutionTotalTimeoutError);
    expect(lock.diagnostics()).toEqual({ users: 0, waiters: 0 });
  });

  it('does not create an Incognito context when authorization lookup crosses its deadline', async () => {
    const deadlineAt = new Date(Date.now() + 5_000);
    const dateSpy = jest.spyOn(Date, 'now');
    const loadSpy = jest
      .spyOn(authorization, 'loadRequiredDependencies')
      .mockImplementationOnce(() => {
        dateSpy.mockReturnValue(deadlineAt.getTime() + 1);
        return Promise.resolve([first]);
      });

    try {
      await expect(
        coordinator.createIncognitoContext({
          userId: USER_ID,
          sessionId: SESSION_ID,
          sessionExpiresAt: new Date(deadlineAt.getTime() + 5_000),
          signal: new AbortController().signal,
          deadlineAt,
        }),
      ).rejects.toBeInstanceOf(AiExecutionTotalTimeoutError);
    } finally {
      loadSpy.mockRestore();
      dateSpy.mockRestore();
    }

    expect(contexts.createCalls).toBe(0);
    expect(lock.diagnostics()).toEqual({ users: 0, waiters: 0 });
  });

  it('aborts the execution when an execution-aware lock call sees an expired deadline', async () => {
    const execution = await boundExecution();
    execution.deadlineAt.setTime(Date.now() - 1);

    await expect(coordinator.assertStillUsable(execution)).rejects.toBeInstanceOf(
      AiExecutionTotalTimeoutError,
    );
    expect(execution.signal.aborted).toBe(true);
    expect(execution.signal.reason).toBeInstanceOf(AiExecutionTotalTimeoutError);
    expect(lock.diagnostics()).toEqual({ users: 0, waiters: 0 });
    execution.dispose();
  });

  it('rechecks a queued waiter deadline at lock handoff without running its operation', async () => {
    const held = deferred();
    const releaseHeld = deferred();
    const owner = lock.runExclusive(
      USER_ID,
      new AbortController().signal,
      new Date(Date.now() + 10_000),
      async () => {
        held.resolve();
        await releaseHeld.promise;
      },
    );
    await held.promise;

    const deadlineAt = new Date(Date.now() + 5_000);
    let operationCalls = 0;
    const waiter = lock.runExclusive(USER_ID, new AbortController().signal, deadlineAt, () => {
      operationCalls += 1;
    });
    expect(lock.diagnostics()).toEqual({ users: 1, waiters: 1 });

    const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(deadlineAt.getTime() + 1);
    try {
      releaseHeld.resolve();
      await owner;
      await expect(waiter).rejects.toBeInstanceOf(AiExecutionTotalTimeoutError);
    } finally {
      dateSpy.mockRestore();
    }

    expect(operationCalls).toBe(0);
    expect(lock.diagnostics()).toEqual({ users: 0, waiters: 0 });
  });

  it('publishes an exact withdrawal after a committed operation loses its acknowledgement', async () => {
    const execution = await boundExecution();
    const recovered = { committed: true, replayed: true };
    const acknowledgementLost = new Error('synthetic_commit_acknowledgement_lost');

    await expect(
      coordinator.coordinateMutation(
        {
          userId: USER_ID,
          signal: new AbortController().signal,
          deadlineAt: new Date(Date.now() + 5_000),
          mayWithdraw: true,
          operationPreviouslyCommitted: false,
          prepareWithdrawal: () => Promise.resolve(withdrawn(first)),
          resolveCommitted: () => Promise.resolve(recovered),
          isDefiniteRollback: () => false,
        },
        () => Promise.reject(acknowledgementLost),
        (_result, source, existed) => ({
          dependency: withdrawn(first),
          invalidatePending: source === 'recovery' && !existed,
        }),
      ),
    ).rejects.toBe(acknowledgementLost);

    expect(execution.signal.aborted).toBe(true);
    expect(contexts.cleared).toEqual([first.acceptanceDecisionId]);
    expect(lock.diagnostics()).toEqual({ users: 0, waiters: 0 });
  });

  it('uses the exact in-lock dependency as a fail-closed guard when reconciliation is unavailable', async () => {
    const execution = await boundExecution();
    const acknowledgementLost = new Error('synthetic_commit_acknowledgement_lost');

    await expect(
      coordinator.coordinateMutation(
        {
          userId: USER_ID,
          signal: new AbortController().signal,
          deadlineAt: new Date(Date.now() + 5_000),
          mayWithdraw: true,
          operationPreviouslyCommitted: false,
          prepareWithdrawal: () => Promise.resolve(withdrawn(first)),
          resolveCommitted: () => Promise.reject(new Error('synthetic_reconciliation_failure')),
          isDefiniteRollback: () => false,
        },
        () => Promise.reject(acknowledgementLost),
        () => null,
      ),
    ).rejects.toBe(acknowledgementLost);

    expect(execution.signal.aborted).toBe(true);
    await expect(
      coordinator.start(execution, 'generation', () => Promise.resolve('unexpected')),
    ).rejects.toBeDefined();
    expect(lock.diagnostics()).toEqual({ users: 0, waiters: 0 });
  });

  it('does not publish a withdrawal for a confirmed transaction rollback', async () => {
    const execution = await boundExecution();
    const rollback = new Error('synthetic_confirmed_rollback');
    let reconciliationCalls = 0;

    await expect(
      coordinator.coordinateMutation(
        {
          userId: USER_ID,
          signal: new AbortController().signal,
          deadlineAt: new Date(Date.now() + 5_000),
          mayWithdraw: true,
          operationPreviouslyCommitted: false,
          prepareWithdrawal: () => Promise.resolve(withdrawn(first)),
          resolveCommitted: () => {
            reconciliationCalls += 1;
            return Promise.resolve(null);
          },
          isDefiniteRollback: (error) => error === rollback,
        },
        () => Promise.reject(rollback),
        () => null,
      ),
    ).rejects.toBe(rollback);

    expect(reconciliationCalls).toBe(0);
    expect(execution.signal.aborted).toBe(false);
    expect(contexts.cleared).toEqual([]);
  });

  it('orders a guarded persistence operation before a concurrent withdrawal', async () => {
    const execution = await boundExecution();
    const persistenceStarted = deferred();
    const releasePersistence = deferred();
    const order: string[] = [];
    const persistence = coordinator.runWhileUsable(execution, async () => {
      order.push('persistence-started');
      persistenceStarted.resolve();
      await releasePersistence.promise;
      order.push('persistence-committed');
      return 'saved';
    });
    await persistenceStarted.promise;
    const withdrawal = publish(first, true).then(() => order.push('withdrawal-committed'));
    await Promise.resolve();
    expect(order).toEqual(['persistence-started']);

    releasePersistence.resolve();
    await expect(persistence).resolves.toBe('saved');
    await withdrawal;
    expect(order).toEqual(['persistence-started', 'persistence-committed', 'withdrawal-committed']);
    expect(execution.signal.aborted).toBe(true);
  });

  it('does not begin guarded persistence after withdrawal has committed', async () => {
    const execution = await boundExecution();
    await publish(first, true);
    let persistenceCalls = 0;
    await expect(
      coordinator.runWhileUsable(execution, () => {
        persistenceCalls += 1;
        return Promise.resolve('unexpected');
      }),
    ).rejects.toBeDefined();
    expect(persistenceCalls).toBe(0);
  });

  it('removes aborted waiters and releases per-user lock state', async () => {
    const held = deferred();
    const release = deferred();
    const firstOperation = lock.runExclusive(
      USER_ID,
      new AbortController().signal,
      new Date(Date.now() + 5_000),
      async () => {
        held.resolve();
        await release.promise;
      },
    );
    await held.promise;
    const waiterController = new AbortController();
    const waiter = lock.runExclusive(
      USER_ID,
      waiterController.signal,
      new Date(Date.now() + 5_000),
      () => undefined,
    );
    waiterController.abort(new Error('synthetic_waiter_abort'));
    await expect(waiter).rejects.toThrow('synthetic_waiter_abort');
    release.resolve();
    await firstOperation;
    expect(lock.diagnostics()).toEqual({ users: 0, waiters: 0 });
  });
});
