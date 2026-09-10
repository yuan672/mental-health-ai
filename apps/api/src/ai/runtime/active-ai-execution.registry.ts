import { randomUUID } from 'node:crypto';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { env } from '../../config/env';

export type ActiveAiExecution = Readonly<{
  id: string;
  signal: AbortSignal;
  abort: (reason?: unknown) => void;
  dispose: () => void;
}>;

export class AiExecutionTotalTimeoutError extends Error {
  constructor() {
    super('AI execution total timeout');
    this.name = AiExecutionTotalTimeoutError.name;
  }
}

type MutableExecution = {
  id: string;
  userId: string;
  sessionId: string;
  controller: AbortController;
  clientSignal: AbortSignal;
  onClientAbort: () => void;
  timer: NodeJS.Timeout;
};

@Injectable()
export class ActiveAiExecutionRegistry implements OnModuleDestroy {
  private readonly executions = new Map<string, MutableExecution>();

  register(input: {
    userId: string;
    sessionId: string;
    clientSignal: AbortSignal;
  }): ActiveAiExecution {
    const id = randomUUID();
    const controller = new AbortController();
    const onClientAbort = (): void =>
      controller.abort(input.clientSignal.reason ?? new Error('client_disconnect'));
    input.clientSignal.addEventListener('abort', onClientAbort, { once: true });
    if (input.clientSignal.aborted) onClientAbort();

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
      timer,
    };
    this.executions.set(id, execution);

    let disposed = false;
    return {
      id,
      signal: controller.signal,
      abort: (reason?: unknown) => controller.abort(reason ?? new Error('ai_execution_cancelled')),
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.release(execution);
      },
    };
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

  private release(execution: MutableExecution): void {
    clearTimeout(execution.timer);
    execution.clientSignal.removeEventListener('abort', execution.onClientAbort);
    this.executions.delete(execution.id);
  }
}
