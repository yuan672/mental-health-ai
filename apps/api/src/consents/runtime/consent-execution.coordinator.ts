import { Inject, Injectable } from '@nestjs/common';
import {
  INCOGNITO_CONTEXT_STORE,
  type IncognitoContext,
  type IncognitoContextStore,
} from '../../ai/incognito/incognito-context.store';
import {
  ActiveAiExecutionRegistry,
  AiExecutionTotalTimeoutError,
  type ActiveAiExecution,
  type ConsentBoundExecution,
} from '../../ai/runtime/active-ai-execution.registry';
import { ConsentRequiredError } from '../../common/errors';
import { env } from '../../config/env';
import {
  CONSENT_AUTHORIZATION_SNAPSHOT,
  type ConsentAuthorizationSnapshotPort,
} from './consent-authorization.port';
import type {
  ConsentDependency,
  ConsentPolicyKey,
  ThirdPartyDispatchKind,
} from './consent-execution.types';
import { consentPolicyKey, sameConsentDependencies } from './consent-execution.types';
import {
  ConsentCoordinationCapacityError,
  ConsentCoordinationNotStartedError,
  PerUserConsentLock,
} from './per-user-consent-lock';

export type ConsentTransportStarter = <T>(
  startTransport: (signal: AbortSignal) => T,
) => Promise<{ readonly transport: T }>;

export interface ConsentDispatchGuard {
  start<T>(
    execution: ConsentBoundExecution,
    kind: ThirdPartyDispatchKind,
    startTransport: (signal: AbortSignal) => T,
  ): Promise<{ readonly transport: T }>;
  assertStillUsable(execution: ConsentBoundExecution): Promise<void>;
  runWhileUsable<T>(execution: ConsentBoundExecution, operation: () => Promise<T>): Promise<T>;
}

type PendingExecution = {
  execution: ActiveAiExecution;
  requiredPolicyKeys: readonly ConsentPolicyKey[];
  observedEpochs: ReadonlyMap<string, number>;
};

type RevokedMarker = { userId: string; expiresAt: number };
export type WithdrawnConsentDependency = Readonly<{
  acceptanceDecisionId: string;
  consentType: ConsentDependency['consentType'];
  consentVersion: string;
}>;

@Injectable()
export class ConsentExecutionCoordinator implements ConsentDispatchGuard {
  private readonly epochs = new Map<string, Map<string, number>>();
  private readonly pending = new Map<string, PendingExecution>();
  private readonly revoked = new Map<string, RevokedMarker>();

  constructor(
    private readonly activeExecutions: ActiveAiExecutionRegistry,
    @Inject(CONSENT_AUTHORIZATION_SNAPSHOT)
    private readonly authorization: ConsentAuthorizationSnapshotPort,
    @Inject(INCOGNITO_CONTEXT_STORE)
    private readonly incognitoContexts: IncognitoContextStore,
    private readonly userLock: PerUserConsentLock,
  ) {}

  registerPending(input: {
    userId: string;
    sessionId: string;
    clientSignal: AbortSignal;
  }): ActiveAiExecution {
    const execution = this.activeExecutions.register(input);
    const requiredPolicyKeys = this.authorization.requiredPolicyKeys();
    const userEpochs = this.epochs.get(input.userId) ?? new Map<string, number>();
    this.epochs.set(input.userId, userEpochs);
    const observedEpochs = new Map(
      requiredPolicyKeys.map((policy) => [
        consentPolicyKey(policy),
        userEpochs.get(consentPolicyKey(policy)) ?? 0,
      ]),
    );
    this.pending.set(execution.id, { execution, requiredPolicyKeys, observedEpochs });
    return this.withDispose(execution);
  }

  async bindRequired(execution: ActiveAiExecution): Promise<ConsentBoundExecution> {
    const pending = this.pending.get(execution.id);
    if (!pending) throw new ConsentRequiredError();
    return this.userLock.runExclusive(
      execution.userId,
      execution.signal,
      execution.deadlineAt,
      async () => {
        this.assertExecutionTime(execution);
        for (const policy of pending.requiredPolicyKeys) {
          if (
            pending.observedEpochs.get(consentPolicyKey(policy)) !==
            (this.epochs.get(execution.userId)?.get(consentPolicyKey(policy)) ?? 0)
          ) {
            throw new ConsentRequiredError();
          }
        }
        const dependencies = await this.authorization.loadRequiredDependencies(execution.userId);
        this.assertDependenciesMatchPolicies(pending.requiredPolicyKeys, dependencies);
        this.assertNotRevoked(execution.userId, dependencies);
        this.assertExecutionTime(execution);
        const bound = this.activeExecutions.bind(execution.id, dependencies);
        this.pending.delete(execution.id);
        this.pruneEpochs(execution.userId);
        return this.withBoundDispose(bound);
      },
    );
  }

  async createIncognitoContext(input: {
    userId: string;
    sessionId: string;
    sessionExpiresAt: Date;
    signal: AbortSignal;
    deadlineAt: Date;
    now?: Date;
  }): Promise<IncognitoContext> {
    return this.userLock.runExclusive(input.userId, input.signal, input.deadlineAt, async () => {
      const dependencies = await this.authorization.loadRequiredDependencies(input.userId);
      this.assertNotRevoked(input.userId, dependencies);
      if (input.signal.aborted) throw input.signal.reason;
      return this.incognitoContexts.create(
        input.userId,
        input.sessionId,
        input.sessionExpiresAt,
        dependencies,
        input.now,
      );
    });
  }

  async assertIncognitoDependencies(
    execution: ConsentBoundExecution,
    context: IncognitoContext,
  ): Promise<void> {
    await this.assertStillUsable(execution);
    if (!sameConsentDependencies(execution.dependencies, context.consentDependencies)) {
      this.incognitoContexts.end(context.userId, context.sessionId, context.id);
      throw new ConsentRequiredError();
    }
  }

  starter(
    execution: ConsentBoundExecution,
    kind: ThirdPartyDispatchKind,
    callSignal: AbortSignal,
  ): ConsentTransportStarter {
    const guardedSignal = AbortSignal.any([execution.signal, callSignal]);
    return <T>(startTransport: (signal: AbortSignal) => T) =>
      this.startWithSignal(execution, kind, guardedSignal, startTransport);
  }

  async start<T>(
    execution: ConsentBoundExecution,
    kind: ThirdPartyDispatchKind,
    startTransport: (signal: AbortSignal) => T,
  ): Promise<{ readonly transport: T }> {
    return this.startWithSignal(execution, kind, execution.signal, startTransport);
  }

  private async startWithSignal<T>(
    execution: ConsentBoundExecution,
    kind: ThirdPartyDispatchKind,
    dispatchSignal: AbortSignal,
    startTransport: (signal: AbortSignal) => T,
  ): Promise<{ readonly transport: T }> {
    return this.userLock.runExclusive(
      execution.userId,
      dispatchSignal,
      execution.deadlineAt,
      async () => {
        this.assertExecutionTime(execution);
        if (dispatchSignal.aborted) throw dispatchSignal.reason;
        this.pruneRevokedMarkers();
        this.assertNotRevoked(execution.userId, execution.dependencies);
        const active = await this.authorization.dependenciesRemainActive(
          execution.userId,
          execution.dependencies,
        );
        if (!active) throw new ConsentRequiredError();
        this.assertExecutionTime(execution);
        if (dispatchSignal.aborted) throw dispatchSignal.reason;
        const transport = startTransport(dispatchSignal);
        this.activeExecutions.markDispatched(execution.id, kind);
        return { transport };
      },
    );
  }

  async assertStillUsable(execution: ConsentBoundExecution): Promise<void> {
    await this.userLock.runExclusive(
      execution.userId,
      execution.signal,
      execution.deadlineAt,
      () => {
        this.assertExecutionTime(execution);
        this.pruneRevokedMarkers();
        this.assertNotRevoked(execution.userId, execution.dependencies);
      },
    );
  }

  async runWhileUsable<T>(
    execution: ConsentBoundExecution,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.userLock.runExclusive(
      execution.userId,
      execution.signal,
      execution.deadlineAt,
      async () => {
        this.assertExecutionTime(execution);
        this.pruneRevokedMarkers();
        this.assertNotRevoked(execution.userId, execution.dependencies);
        const active = await this.authorization.dependenciesRemainActive(
          execution.userId,
          execution.dependencies,
        );
        if (!active) throw new ConsentRequiredError();
        this.assertExecutionTime(execution);
        const result = await operation();
        this.assertExecutionTime(execution);
        return result;
      },
    );
  }

  async coordinateMutation<T>(
    input: {
      userId: string;
      signal: AbortSignal;
      deadlineAt: Date;
      mayWithdraw: boolean;
      operationPreviouslyCommitted: boolean;
      prepareWithdrawal: () => Promise<WithdrawnConsentDependency | null>;
      resolveCommitted: () => Promise<T | null>;
      isDefiniteRollback: (error: unknown) => boolean;
    },
    commit: () => Promise<T>,
    withdrawalEffect: (
      result: T,
      source: 'commit' | 'recovery',
      operationPreviouslyCommitted: boolean,
    ) => Readonly<{
      dependency: WithdrawnConsentDependency;
      invalidatePending: boolean;
    }> | null,
  ): Promise<T> {
    let commitStarted = false;
    try {
      return await this.userLock.runExclusive(
        input.userId,
        input.signal,
        input.deadlineAt,
        async () => {
          const withdrawalCandidate = input.mayWithdraw ? await input.prepareWithdrawal() : null;
          if (withdrawalCandidate) {
            this.ensureRevokedMarkerCapacity(withdrawalCandidate.acceptanceDecisionId);
          }
          commitStarted = true;
          try {
            const result = await commit();
            const effect = withdrawalEffect(result, 'commit', input.operationPreviouslyCommitted);
            if (effect) {
              this.publishWithdrawal(input.userId, effect.dependency, effect.invalidatePending);
            }
            return result;
          } catch (error) {
            if (input.isDefiniteRollback(error)) throw error;

            let recovered: T | null;
            try {
              recovered = await input.resolveCommitted();
            } catch {
              if (withdrawalCandidate) {
                this.publishWithdrawal(
                  input.userId,
                  withdrawalCandidate,
                  !input.operationPreviouslyCommitted,
                );
              }
              throw error;
            }

            if (recovered) {
              const effect = withdrawalEffect(
                recovered,
                'recovery',
                input.operationPreviouslyCommitted,
              );
              if (effect) {
                this.publishWithdrawal(input.userId, effect.dependency, effect.invalidatePending);
              }
            }
            throw error;
          }
        },
      );
    } catch (error) {
      if (!commitStarted) throw new ConsentCoordinationNotStartedError(error);
      throw error;
    }
  }

  async reconcileWithdrawal(input: {
    userId: string;
    dependency: ConsentDependency;
    signal: AbortSignal;
    deadlineAt: Date;
  }): Promise<void> {
    await this.userLock.runExclusive(input.userId, input.signal, input.deadlineAt, () => {
      this.ensureRevokedMarkerCapacity(input.dependency.acceptanceDecisionId);
      this.publishWithdrawal(input.userId, input.dependency, false);
    });
  }

  private publishWithdrawal(
    userId: string,
    dependency: WithdrawnConsentDependency,
    invalidatePending: boolean,
  ): void {
    const alreadyRevoked = this.revoked.has(dependency.acceptanceDecisionId);
    if (invalidatePending && !alreadyRevoked) this.incrementEpoch(userId, dependency);
    if (
      this.revoked.has(dependency.acceptanceDecisionId) ||
      this.activeExecutions.hasDependency(dependency.acceptanceDecisionId) ||
      this.incognitoContexts.hasDependency(dependency.acceptanceDecisionId)
    ) {
      this.revoked.set(dependency.acceptanceDecisionId, {
        userId,
        expiresAt: Date.now() + env.CONSENT_REVOKED_MARKER_MAX_LIFETIME_MS,
      });
    }
    this.activeExecutions.abortDependency(userId, dependency.acceptanceDecisionId);
    this.incognitoContexts.clearDependency(userId, dependency.acceptanceDecisionId);
  }

  private assertExecutionTime(execution: ActiveAiExecution): void {
    if (execution.signal.aborted) throw execution.signal.reason;
    if (execution.deadlineAt.getTime() <= Date.now()) {
      execution.abort(new AiExecutionTotalTimeoutError());
      throw execution.signal.reason;
    }
  }

  private assertNotRevoked(userId: string, dependencies: readonly ConsentDependency[]): void {
    for (const dependency of dependencies) {
      const marker = this.revoked.get(dependency.acceptanceDecisionId);
      if (marker?.userId === userId) throw new ConsentRequiredError();
    }
  }

  private assertDependenciesMatchPolicies(
    policies: readonly ConsentPolicyKey[],
    dependencies: readonly ConsentDependency[],
  ): void {
    if (policies.length !== dependencies.length) throw new ConsentRequiredError();
    const dependenciesByKey = new Set(dependencies.map(consentPolicyKey));
    if (!policies.every((policy) => dependenciesByKey.has(consentPolicyKey(policy)))) {
      throw new ConsentRequiredError();
    }
  }

  private incrementEpoch(userId: string, dependency: WithdrawnConsentDependency): void {
    const epochs = this.epochs.get(userId);
    if (!epochs) return;
    const key = consentPolicyKey(dependency);
    epochs.set(key, (epochs.get(key) ?? 0) + 1);
  }

  private ensureRevokedMarkerCapacity(acceptanceDecisionId?: string): void {
    this.pruneRevokedMarkers();
    if (
      acceptanceDecisionId &&
      !this.revoked.has(acceptanceDecisionId) &&
      !this.activeExecutions.hasDependency(acceptanceDecisionId) &&
      !this.incognitoContexts.hasDependency(acceptanceDecisionId)
    ) {
      return;
    }
    if (
      (!acceptanceDecisionId || !this.revoked.has(acceptanceDecisionId)) &&
      this.revoked.size >= env.CONSENT_REVOKED_MARKER_MAX_GLOBAL
    ) {
      throw new ConsentCoordinationCapacityError('revoked_marker_limit');
    }
  }

  private pruneRevokedMarkers(): void {
    const now = Date.now();
    for (const [decisionId, marker] of this.revoked) {
      if (marker.expiresAt > now) continue;
      if (
        !this.activeExecutions.hasDependency(decisionId) &&
        !this.incognitoContexts.hasDependency(decisionId)
      ) {
        this.revoked.delete(decisionId);
      }
    }
  }

  private withDispose(execution: ActiveAiExecution): ActiveAiExecution {
    return {
      id: execution.id,
      userId: execution.userId,
      sessionId: execution.sessionId,
      signal: execution.signal,
      deadlineAt: execution.deadlineAt,
      get dependencies() {
        return execution.dependencies;
      },
      abort: execution.abort,
      dispose: () => {
        this.pending.delete(execution.id);
        this.pruneEpochs(execution.userId);
        execution.dispose();
      },
    };
  }

  private withBoundDispose(execution: ConsentBoundExecution): ConsentBoundExecution {
    return {
      ...execution,
      dispose: () => {
        this.pending.delete(execution.id);
        this.pruneEpochs(execution.userId);
        execution.dispose();
      },
    };
  }

  private pruneEpochs(userId: string): void {
    if ([...this.pending.values()].some((pending) => pending.execution.userId === userId)) return;
    this.epochs.delete(userId);
  }
}
