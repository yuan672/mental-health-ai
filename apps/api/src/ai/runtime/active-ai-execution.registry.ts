import { randomUUID } from 'node:crypto';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { env } from '../../config/env';
import type {
  ConsentDependency,
  ThirdPartyDispatchKind,
} from '../../consents/runtime/consent-execution.types';

export type ActiveAiExecution = Readonly<{
  id: string;
  userId: string;
  sessionId: string;
  signal: AbortSignal;
  deadlineAt: Date;
  dependencies: readonly ConsentDependency[] | null;
  abort: (reason?: unknown) => void;
  dispose: () => void;
}>;

export type ConsentBoundExecution = Omit<ActiveAiExecution, 'dependencies'> &
  Readonly<{ dependencies: readonly ConsentDependency[] }>;

export class AiExecutionTotalTimeoutError extends Error {
  constructor() {
    super('AI execution total timeout');
    this.name = AiExecutionTotalTimeoutError.name;
  }
}

export class ActiveAiExecutionCapacityError extends Error {
  constructor(public readonly reason: 'global_limit' | 'user_limit') {
    super(`Active AI execution capacity reached: ${reason}`);
    this.name = ActiveAiExecutionCapacityError.name;
  }
}

type MutableExecution = {
  id: string;
  userId: string;
  sessionId: string;
  controller: AbortController;
  clientSignal: AbortSignal;
  onClientAbort: () => void;
  deadlineAt: Date;
  timer: NodeJS.Timeout;
  dependencies: readonly ConsentDependency[] | null;
  dispatches: Set<ThirdPartyDispatchKind>;
};

@Injectable()
export class ActiveAiExecutionRegistry implements OnModuleDestroy {
  private readonly executions = new Map<string, MutableExecution>();

  register(input: {
    userId: string;
    sessionId: string;
    clientSignal: AbortSignal;
  }): ActiveAiExecution {
    this.assertCapacity(input.userId);
    const id = randomUUID();
    const controller = new AbortController();
    const onClientAbort = (): void =>
      controller.abort(input.clientSignal.reason ?? new Error('client_disconnect'));
    input.clientSignal.addEventListener('abort', onClientAbort, { once: true });
    if (input.clientSignal.aborted) onClientAbort();

    const deadlineAt = new Date(Date.now() + env.LLM_TOTAL_TIMEOUT_MS);
    const timer = setTimeout(
      () => controller.abort(new AiExecutionTotalTimeoutError()),
      env.LLM_TOTAL_TIMEOUT_MS,
    );
    timer.unref();
    const execution: MutableExecution = {
      id,
      userId: input.userId,
      sessionId: input.sessionId,
      controller,
      clientSignal: input.clientSignal,
      onClientAbort,
      deadlineAt,
      timer,
      dependencies: null,
      dispatches: new Set(),
    };
    this.executions.set(id, execution);

    let disposed = false;
    return {
      id,
      userId: input.userId,
      sessionId: input.sessionId,
      signal: controller.signal,
      deadlineAt,
      get dependencies() {
        return execution.dependencies;
      },
      abort: (reason?: unknown) => controller.abort(reason ?? new Error('ai_execution_cancelled')),
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.release(execution);
      },
    };
  }

  bind(executionId: string, dependencies: readonly ConsentDependency[]): ConsentBoundExecution {
    const execution = this.require(executionId);
    if (execution.dependencies)
      throw new Error('AI execution Consent dependencies are already bound');
    execution.dependencies = dependencies.map((dependency) => ({ ...dependency }));
    return this.snapshotBound(execution);
  }

  markDispatched(executionId: string, kind: ThirdPartyDispatchKind): void {
    this.require(executionId).dispatches.add(kind);
  }

  abortSession(userId: string, sessionId: string, reason = 'session_ended'): number {
    return this.abortMatching(
      (execution) => execution.userId === userId && execution.sessionId === sessionId,
      reason,
    );
  }

  abortUser(userId: string, reason = 'consent_withdrawn'): number {
    return this.abortMatching((execution) => execution.userId === userId, reason);
  }

  abortDependency(
    userId: string,
    acceptanceDecisionId: string,
    reason = 'consent_withdrawn',
  ): number {
    return this.abortMatching(
      (execution) =>
        execution.userId === userId &&
        Boolean(
          execution.dependencies?.some(
            (dependency) => dependency.acceptanceDecisionId === acceptanceDecisionId,
          ),
        ),
      reason,
    );
  }

  hasDependency(acceptanceDecisionId: string): boolean {
    return [...this.executions.values()].some((execution) =>
      execution.dependencies?.some(
        (dependency) => dependency.acceptanceDecisionId === acceptanceDecisionId,
      ),
    );
  }

  onModuleDestroy(): void {
    for (const execution of [...this.executions.values()]) {
      execution.controller.abort(new Error('application_shutdown'));
      this.release(execution);
    }
  }

  private abortMatching(
    predicate: (execution: MutableExecution) => boolean,
    reason: string,
  ): number {
    let aborted = 0;
    for (const execution of this.executions.values()) {
      if (!predicate(execution)) continue;
      if (!execution.controller.signal.aborted) {
        execution.controller.abort(new Error(reason));
        aborted += 1;
      }
    }
    return aborted;
  }

  private assertCapacity(userId: string): void {
    if (this.executions.size >= env.CONSENT_ACTIVE_EXECUTIONS_MAX_GLOBAL) {
      throw new ActiveAiExecutionCapacityError('global_limit');
    }
    let userExecutions = 0;
    for (const execution of this.executions.values()) {
      if (execution.userId === userId) userExecutions += 1;
    }
    if (userExecutions >= env.CONSENT_ACTIVE_EXECUTIONS_MAX_PER_USER) {
      throw new ActiveAiExecutionCapacityError('user_limit');
    }
  }

  private require(executionId: string): MutableExecution {
    const execution = this.executions.get(executionId);
    if (!execution) throw new Error('AI execution is no longer active');
    return execution;
  }

  private snapshotBound(execution: MutableExecution): ConsentBoundExecution {
    if (!execution.dependencies) throw new Error('AI execution Consent dependencies are not bound');
    const dependencies = execution.dependencies;
    return {
      id: execution.id,
      userId: execution.userId,
      sessionId: execution.sessionId,
      signal: execution.controller.signal,
      deadlineAt: new Date(execution.deadlineAt),
      dependencies: dependencies.map((dependency) => ({ ...dependency })),
      abort: (reason?: unknown) =>
        execution.controller.abort(reason ?? new Error('ai_execution_cancelled')),
      dispose: () => this.release(execution),
    };
  }

  private release(execution: MutableExecution): void {
    if (this.executions.get(execution.id) !== execution) return;
    clearTimeout(execution.timer);
    execution.clientSignal.removeEventListener('abort', execution.onClientAbort);
    execution.dependencies = null;
    execution.dispatches.clear();
    this.executions.delete(execution.id);
  }
}
