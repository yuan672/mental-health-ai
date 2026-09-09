import type { PinoLogger } from 'nestjs-pino';
import { AiOperationalLoggingService } from '../src/ai/logging/ai-operational-logging.service';
import {
  deriveIncognitoQuotaIdempotencyKey,
  InMemoryIncognitoContextStore,
} from '../src/ai/incognito/incognito-context.store';
import {
  assertAiSafetyConfiguration,
  PassThroughPostGenerationSafetyGate,
  PassThroughPreGenerationSafetyGate,
} from '../src/ai/safety/safety-gates';
import { SentenceSegmentBuffer } from '../src/ai/streaming/sentence-segment-buffer';
import { ConservativeTokenEstimator } from '../src/ai/context/token-estimator';

describe('Phase 3 AI foundation units', () => {
  it('buffers complete sentences, newlines, hard caps, and elapsed partial segments', () => {
    const buffer = new SentenceSegmentBuffer(5, 100);
    expect(buffer.append('你好', 1_000)).toEqual([]);
    expect(buffer.append('。继续', 1_010)).toEqual(['你好。']);
    expect(buffer.append('内容足够长', 1_020)).toEqual(['继续内容足']);
    expect(buffer.flush()).toBe('够长');
    expect(buffer.append('等待', 2_000)).toEqual([]);
    expect(buffer.flushIfDue(2_099)).toBeNull();
    expect(buffer.flushIfDue(2_100)).toBe('等待');
    expect(buffer.append('换行\n剩余', 3_000)).toEqual(['换行\n']);
    expect(buffer.flush()).toBe('剩余');
  });

  it('marks pass-through gates unsafe and fails closed outside development/test', () => {
    const pre = new PassThroughPreGenerationSafetyGate();
    const post = new PassThroughPostGenerationSafetyGate();
    expect(pre.productionSafe).toBe(false);
    expect(post.productionSafe).toBe(false);
    expect(() => assertAiSafetyConfiguration('development', true, pre, post)).not.toThrow();
    expect(() => assertAiSafetyConfiguration('test', true, pre, post)).not.toThrow();
    expect(() => assertAiSafetyConfiguration('production', false, pre, post)).not.toThrow();
    expect(() => assertAiSafetyConfiguration('staging', true, pre, post)).toThrow(
      'cannot use pass-through safety gates',
    );
    expect(() => assertAiSafetyConfiguration('production', true, pre, post)).toThrow(
      'cannot use pass-through safety gates',
    );
  });

  it('keeps incognito context isolated by user/session and removes it on TTL/end/logout', () => {
    const store = new InMemoryIncognitoContextStore();
    const now = new Date('2026-09-09T00:00:00.000Z');
    const first = store.create('user-1', 'session-1', now);
    const second = store.create('user-1', 'session-2', now);
    expect(
      store.append('user-1', 'session-1', first.id, { role: 'user', content: 'private' }, now),
    ).toMatchObject({ messages: [{ role: 'user', content: 'private' }] });
    expect(store.get('user-2', 'session-1', first.id, now)).toBeNull();
    expect(store.get('user-1', 'session-2', first.id, now)).toBeNull();
    expect(
      store.get('user-1', 'session-1', first.id, new Date('2026-09-10T00:00:00.000Z')),
    ).toBeNull();
    expect(store.end('user-1', 'session-2', second.id)).toBe(true);

    const third = store.create('user-1', 'session-3', now);
    expect(store.clearSession('user-1', 'session-3')).toBe(1);
    expect(store.get('user-1', 'session-3', third.id, now)).toBeNull();
    store.onModuleDestroy();
  });

  it('derives stable incognito quota keys only from identity/session/request identifiers', () => {
    const first = deriveIncognitoQuotaIdempotencyKey('user', 'session', 'request');
    const repeated = deriveIncognitoQuotaIdempotencyKey('user', 'session', 'request');
    expect(first).toBe(repeated);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(deriveIncognitoQuotaIdempotencyKey('user', 'other-session', 'request')).not.toBe(first);
  });

  it('documents its token count as a conservative estimate', () => {
    const estimator = new ConservativeTokenEstimator();
    expect(estimator.estimate('hello')).toBeGreaterThan(0);
    expect(estimator.estimate('心理支持')).toBeGreaterThan(estimator.estimate('a'));
  });

  it('logs only allowlisted operational metadata', () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      setContext: jest.fn(),
    } as unknown as PinoLogger;
    const service = new AiOperationalLoggingService(logger);
    service.turnCompleted(
      { userId: 'user-id', conversationId: 'conversation-id', turnId: 'turn-id' },
      {
        provider: 'siliconflow',
        model: 'model-id',
        providerRequestId: 'safe-trace-id',
        durationMs: 100,
        timeToFirstTokenMs: 20,
        usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
        finishReason: 'stop',
      },
    );

    const serialized = JSON.stringify((logger.info as jest.Mock).mock.calls);
    expect(serialized).toContain('llm_request_completed');
    expect(serialized).not.toContain('message');
    expect(serialized).not.toContain('prompt');
    expect(serialized).not.toContain('apiKey');
  });
});
