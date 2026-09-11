import { EventEmitter } from 'node:events';
import { Logger, type ArgumentsHost } from '@nestjs/common';
import type { Response } from 'express';
import type { PinoLogger } from 'nestjs-pino';
import { AiController } from '../src/ai/ai.controller';
import type { AiOrchestrationService } from '../src/ai/ai-orchestration.service';
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
import type { AuthenticatedRequest } from '../src/auth/authenticated-request';
import { AIProviderError } from '../src/common/errors';
import { AppExceptionFilter } from '../src/common/filters/app-exception.filter';
import type { ConsentExecutionCoordinator } from '../src/consents/runtime/consent-execution.coordinator';

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
    const sessionExpiresAt = new Date(now.getTime() + 120_000);
    const first = store.create('user-1', 'session-1', sessionExpiresAt, [], now);
    const second = store.create('user-1', 'session-2', sessionExpiresAt, [], now);
    const generation = store.claimGeneration(
      'user-1',
      'session-1',
      first.id,
      'request-1',
      new AbortController().signal,
      now,
    );
    if (!generation) throw new Error('Expected an Incognito generation claim');
    expect(
      store.append(
        'user-1',
        'session-1',
        first.id,
        generation.id,
        { role: 'user', content: 'private' },
        now,
      ),
    ).toMatchObject({ messages: [{ role: 'user', content: 'private' }] });
    expect(store.get('user-2', 'session-1', first.id, now)).toBeNull();
    expect(store.get('user-1', 'session-2', first.id, now)).toBeNull();
    expect(
      store.get('user-1', 'session-1', first.id, new Date('2026-09-10T00:00:00.000Z')),
    ).toBeNull();
    expect(store.end('user-1', 'session-2', second.id)).toBe(true);

    const third = store.create('user-1', 'session-3', sessionExpiresAt, [], now);
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

describe('pre-stream response lifecycle', () => {
  function responseDouble() {
    const response = new EventEmitter() as EventEmitter & {
      destroyed: boolean;
      writableEnded: boolean;
      vary: jest.Mock;
    };
    response.destroyed = false;
    response.writableEnded = false;
    response.vary = jest.fn();
    return response;
  }

  const request = {
    authenticatedSession: { id: 'session-1', userId: 'user-1' },
  } as AuthenticatedRequest;

  it.each(['persistent', 'incognito'] as const)(
    'does not raise a late %s error when the response closes during cleanup',
    async (mode) => {
      const aborted = new AbortController();
      aborted.abort(new Error('consent_withdrawn'));
      const execution = {
        id: 'execution-1',
        userId: 'user-1',
        sessionId: 'session-1',
        signal: aborted.signal,
        deadlineAt: new Date(Date.now() + 1_000),
        dependencies: [],
        abort: jest.fn(),
        dispose: jest.fn(),
      };
      const prepared =
        mode === 'persistent'
          ? { kind: 'ready', turn: { id: 'turn-1' }, execution }
          : {
              kind: 'ready',
              generation: { id: 'generation-1', signal: aborted.signal },
              execution,
            };
      const response = responseDouble();
      const preProviderTerminationError = jest.fn(() => new AIProviderError());
      const orchestration = {
        preparePersistentTurn: jest.fn().mockResolvedValue(prepared),
        prepareIncognitoTurn: jest.fn().mockResolvedValue(prepared),
        cancelPreparedPersistentTurnBeforeProvider: jest.fn(async () => {
          await Promise.resolve();
          response.destroyed = true;
        }),
        cancelPreparedIncognitoTurnBeforeProvider: jest.fn(async () => {
          await Promise.resolve();
          response.destroyed = true;
        }),
        enforcePreparedExecutionDeadline: jest.fn(),
        preProviderTerminationError,
      } as unknown as AiOrchestrationService;
      const controller = new AiController(orchestration, {} as ConsentExecutionCoordinator);

      await expect(
        controller.streamChat(
          request,
          response as unknown as Response,
          undefined,
          mode === 'persistent'
            ? {
                mode: 'persistent',
                clientRequestId: '11111111-1111-4111-8111-111111111111',
                conversationId: '22222222-2222-4222-8222-222222222222',
                message: 'synthetic',
              }
            : {
                mode: 'incognito',
                clientRequestId: '11111111-1111-4111-8111-111111111111',
                contextId: '22222222-2222-4222-8222-222222222222',
                message: 'synthetic',
              },
        ),
      ).resolves.toBeUndefined();
      expect(preProviderTerminationError).not.toHaveBeenCalled();
    },
  );

  it('does not write replay metadata when the response closes during prepare', async () => {
    const response = responseDouble() as ReturnType<typeof responseDouble> & {
      status: jest.Mock;
      json: jest.Mock;
    };
    response.status = jest.fn(() => response);
    response.json = jest.fn(() => response);
    const orchestration = {
      preparePersistentTurn: jest.fn(async () => {
        response.destroyed = true;
        return { kind: 'existing', turn: { id: 'turn-1' } };
      }),
    } as unknown as AiOrchestrationService;
    const controller = new AiController(orchestration, {} as ConsentExecutionCoordinator);

    await expect(
      controller.streamChat(request, response as unknown as Response, undefined, {
        mode: 'persistent',
        clientRequestId: '11111111-1111-4111-8111-111111111111',
        conversationId: '22222222-2222-4222-8222-222222222222',
        message: 'synthetic',
      }),
    ).resolves.toBeUndefined();
    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
  });

  it('logs but never writes an exception envelope after the socket is closed', () => {
    const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const response = {
      destroyed: true,
      writableEnded: false,
      headersSent: false,
      setHeader: jest.fn(),
      status: jest.fn(),
      json: jest.fn(),
    };
    const request = { id: 'request-1', method: 'POST', path: '/ai/chat/stream' };
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => request,
      }),
    } as unknown as ArgumentsHost;

    try {
      new AppExceptionFilter().catch(new AIProviderError(), host);
      expect(response.setHeader).not.toHaveBeenCalled();
      expect(response.status).not.toHaveBeenCalled();
      expect(response.json).not.toHaveBeenCalled();
      expect(logger).toHaveBeenCalled();
    } finally {
      logger.mockRestore();
    }
  });
});
