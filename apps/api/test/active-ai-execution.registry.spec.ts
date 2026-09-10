import {
  ActiveAiExecutionRegistry,
  AiExecutionTotalTimeoutError,
} from '../src/ai/runtime/active-ai-execution.registry';

describe('Active AI execution registry', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('aborts only executions in the requested session or user scope', () => {
    const registry = new ActiveAiExecutionRegistry();
    const first = registry.register({
      userId: 'user-1',
      sessionId: 'session-1',
      clientSignal: new AbortController().signal,
    });
    const second = registry.register({
      userId: 'user-1',
      sessionId: 'session-2',
      clientSignal: new AbortController().signal,
    });
    const otherUser = registry.register({
      userId: 'user-2',
      sessionId: 'session-3',
      clientSignal: new AbortController().signal,
    });

    expect(registry.abortSession('user-1', 'session-1')).toBe(1);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(otherUser.signal.aborted).toBe(false);
    expect(registry.abortUser('user-1')).toBe(1);
    expect(second.signal.aborted).toBe(true);
    expect(otherUser.signal.aborted).toBe(false);
    registry.onModuleDestroy();
    expect(otherUser.signal.aborted).toBe(true);
  });

  it('propagates client cancellation and enforces the total deadline', () => {
    jest.useFakeTimers();
    const registry = new ActiveAiExecutionRegistry();
    const client = new AbortController();
    const cancelled = registry.register({
      userId: 'user-1',
      sessionId: 'session-1',
      clientSignal: client.signal,
    });
    client.abort(new Error('client_cancelled'));
    expect(cancelled.signal.aborted).toBe(true);
    expect((cancelled.signal.reason as Error).message).toBe('client_cancelled');
    cancelled.dispose();

    const timedOut = registry.register({
      userId: 'user-1',
      sessionId: 'session-1',
      clientSignal: new AbortController().signal,
    });
    jest.runOnlyPendingTimers();
    expect(timedOut.signal.aborted).toBe(true);
    expect(timedOut.signal.reason).toBeInstanceOf(AiExecutionTotalTimeoutError);
    registry.onModuleDestroy();
  });
});
