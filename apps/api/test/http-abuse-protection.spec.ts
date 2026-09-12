import { Controller, Get, INestApplication, UseGuards } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppExceptionFilter } from '../src/common/filters/app-exception.filter';
import { RateLimitError } from '../src/common/errors';
import { SecurityLoggingService } from '../src/security/security-logging.service';
import { CredentialWorkAdmissionService } from '../src/http-abuse/credential-work-admission.service';
import { HttpAbuseAdmissionService } from '../src/http-abuse/http-abuse-admission.service';
import { createHttpRequestLifecycle } from '../src/http-abuse/http-request-lifecycle';
import {
  HTTP_INGRESS_METADATA,
  HTTP_PRINCIPAL_METADATA,
  HttpIngress,
  HttpPrincipal,
  SkipHttpRateLimit,
} from '../src/http-abuse/http-abuse.metadata';
import { IngressRateLimitGuard } from '../src/http-abuse/ingress-rate-limit.guard';
import { directNetworkIdentity } from '../src/http-abuse/network-identity';
import { PrincipalRateLimitInterceptor } from '../src/http-abuse/principal-rate-limit.interceptor';
import { ProcessLocalTokenBucketStore } from '../src/http-abuse/process-local-token-bucket.store';
import {
  HTTP_RATE_LIMIT_CONFIG,
  HTTP_RATE_LIMIT_POLICIES,
  MONOTONIC_CLOCK,
  type HttpRateLimitConfiguration,
  type MonotonicClock,
} from '../src/http-abuse/http-abuse.types';
import { ConsentsController } from '../src/consents/consents.controller';
import { AiController } from '../src/ai/ai.controller';
import { ActiveAiExecutionCapacityError } from '../src/ai/runtime/active-ai-execution.registry';
import { AuthController } from '../src/auth/auth.controller';
import { ConversationAccessController } from '../src/conversation-access/conversation-access.controller';
import { MoodController } from '../src/mood/mood.controller';
import { IncognitoContextsController } from '../src/ai/incognito/incognito-contexts.controller';
import { AdminController } from '../src/admin/admin.controller';
import { createCorsOptions } from '../src/common/http/cors-options';
import { AppModule } from '../src/app.module';
import { env } from '../src/config/env';

function configuration(
  overrides: Partial<
    Record<(typeof HTTP_RATE_LIMIT_POLICIES)[number], { capacity: number; refill: number }>
  > = {},
  maxKeys = 4,
): HttpRateLimitConfiguration {
  const policies = Object.fromEntries(
    HTTP_RATE_LIMIT_POLICIES.map((policy) => {
      const value = overrides[policy] ?? { capacity: 10, refill: 1 };
      return [policy, { capacity: value.capacity, refillTokensPerSecond: value.refill, maxKeys }];
    }),
  ) as HttpRateLimitConfiguration['policies'];
  return {
    policies,
    keyTtlMs: 1_000,
    sweepIntervalMs: 500,
    sweepBatchSize: 64,
    retryAfterMaximumSeconds: 30,
    credentialMaxConcurrency: 1,
    credentialOperationTimeoutMs: 1_000,
  };
}

function loggerDouble(): jest.Mocked<Pick<SecurityLoggingService, 'httpRateLimited'>> {
  return { httpRateLimited: jest.fn() };
}

@Controller('limited')
class LimitedController {
  @Get()
  @HttpIngress('standard', 'public_read')
  read() {
    return { success: true };
  }
}

@Controller('reserved')
class ReservedController {
  @Get()
  @HttpIngress('control')
  read() {
    return { success: true };
  }
}

@Controller('unlimited-health')
@SkipHttpRateLimit()
class UnlimitedController {
  @Get()
  read() {
    return { success: true };
  }
}

class SyntheticAuthenticationGuard {
  canActivate(context: Parameters<IngressRateLimitGuard['canActivate']>[0]): boolean {
    const httpRequest = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      authenticatedSession?: { userId: string };
    }>();
    httpRequest.authenticatedSession = {
      userId: httpRequest.headers['x-synthetic-user'] ?? '00000000-0000-4000-8000-000000000001',
    };
    return true;
  }
}

@Controller('principal')
@UseGuards(SyntheticAuthenticationGuard)
@HttpPrincipal('principal_general')
class PrincipalController {
  @Get()
  read() {
    return { success: true };
  }
}

describe('minimum HTTP abuse protection', () => {
  it('uses a monotonic token bucket with bounded retry and independent partitions', () => {
    let monotonicNow = 0;
    const clock: MonotonicClock = { now: () => monotonicNow };
    const store = new ProcessLocalTokenBucketStore(
      configuration({
        network_standard: { capacity: 1, refill: 0.5 },
        network_control: { capacity: 1, refill: 1 },
      }),
      clock,
    );
    try {
      expect(store.consume('network_standard', 'same-peer')).toEqual({ allowed: true });
      expect(store.consume('network_standard', 'same-peer')).toEqual({
        allowed: false,
        reason: 'token_exhausted',
        retryAfterSeconds: 2,
      });
      expect(store.consume('network_control', 'same-peer')).toEqual({ allowed: true });
      monotonicNow += 2_000;
      expect(store.consume('network_standard', 'same-peer')).toEqual({ allowed: true });
    } finally {
      store.onModuleDestroy();
    }
  });

  it('does not evict active keys to admit address churn and releases only expired entries', () => {
    let monotonicNow = 0;
    const clock: MonotonicClock = { now: () => monotonicNow };
    const store = new ProcessLocalTokenBucketStore(configuration({}, 1), clock);
    try {
      expect(store.consume('public_read', 'peer-a')).toEqual({ allowed: true });
      expect(store.consume('public_read', 'peer-b')).toEqual({
        allowed: false,
        reason: 'key_capacity',
      });
      monotonicNow = 1_001;
      // Sweep rotates through hard partitions; bounded passes eventually reach public_read.
      for (let index = 0; index < HTTP_RATE_LIMIT_POLICIES.length; index += 1) {
        store.sweepExpired(monotonicNow);
      }
      expect(store.size('public_read')).toBe(0);
      expect(store.consume('public_read', 'peer-b')).toEqual({ allowed: true });
    } finally {
      store.onModuleDestroy();
    }
  });

  it('normalizes only the direct peer and ignores forwarded identity headers', () => {
    const socket = { remoteAddress: '::ffff:127.0.0.1' };
    expect(directNetworkIdentity({ socket } as never)).toBe('127.0.0.1');
    expect(
      directNetworkIdentity({
        socket,
        headers: { 'x-forwarded-for': '203.0.113.8', forwarded: 'for=203.0.113.9' },
      } as never),
    ).toBe('127.0.0.1');
    expect(directNetworkIdentity({ socket: { remoteAddress: 'not-an-address' } } as never)).toBe(
      'unknown-direct-peer',
    );
    expect(
      directNetworkIdentity({
        socket: { remoteAddress: '2001:0DB8:0:0:0:0:0:1%ethernet' },
      } as never),
    ).toBe('2001:db8::1');
    expect(directNetworkIdentity({ socket: { remoteAddress: '2001:db8::1' } } as never)).toBe(
      '2001:db8::1',
    );
  });

  it('logs only allowlisted limiter metadata and never the identity key', () => {
    const warn = jest.fn();
    const logger = new SecurityLoggingService({ setContext: jest.fn(), warn } as never);
    logger.httpRateLimited('ai_new_work', 'user', 'token_exhausted');
    expect(warn).toHaveBeenCalledWith({
      event: 'http_rate_limited',
      policyGroup: 'ai_new_work',
      identityKind: 'user',
      reason: 'token_exhausted',
      eventCategory: 'security',
    });
  });

  it('holds an Argon2 permit until actual work settles after cancellation', async () => {
    const logs = loggerDouble();
    const admission = new CredentialWorkAdmissionService(
      configuration(),
      logs as unknown as SecurityLoggingService,
    );
    const controller = new AbortController();
    let settle!: () => void;
    const nativeWork = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const first = admission.run(controller.signal, () => nativeWork);
    expect(admission.activeCount).toBe(1);
    controller.abort(new Error('synthetic_disconnect'));
    await expect(
      admission.run(new AbortController().signal, async () => undefined),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(admission.activeCount).toBe(1);
    settle();
    await expect(first).rejects.toThrow('synthetic_disconnect');
    expect(admission.activeCount).toBe(0);
    expect(logs.httpRateLimited).toHaveBeenCalledWith(
      'credential_work',
      'network',
      'concurrency_capacity',
    );
  });

  it('bounds credential request lifetime and removes request listeners on disposal', () => {
    const requestEvents = new EventEmitter();
    const responseEvents = new EventEmitter();
    const lifecycle = createHttpRequestLifecycle(
      requestEvents as never,
      responseEvents as never,
      1_000,
    );
    expect(requestEvents.listenerCount('aborted')).toBe(1);
    expect(responseEvents.listenerCount('close')).toBe(1);
    responseEvents.emit('close');
    expect(lifecycle.signal.aborted).toBe(true);
    expect((lifecycle.signal.reason as Error).message).toBe('client_disconnect');
    lifecycle.dispose();
    expect(requestEvents.listenerCount('aborted')).toBe(0);
    expect(responseEvents.listenerCount('close')).toBe(0);
  });

  it('selects a Consent mutation lane only from the bounded server-side lookup', async () => {
    const calls: string[] = [];
    const service = {
      classifyHttpAdmission: jest.fn(async () => {
        calls.push('lookup');
        return 'control_recovery' as const;
      }),
      mutate: jest.fn(async () => {
        calls.push('mutate');
        return { success: true };
      }),
    };
    const admission = {
      admit: jest.fn((policy: string) => calls.push(`admit:${policy}`)),
    };
    const controller = new ConsentsController(service as never, admission as never);
    await controller.mutate({ authenticatedSession: { userId: 'user-1' } } as never, {
      action: 'withdraw',
      operationId: '11111111-1111-4111-8111-111111111111',
      consentType: 'terms_of_service',
      consentVersion: '1.1',
      expectedRevision: 1,
    });
    expect(calls).toEqual([
      'admit:classification_probe',
      'lookup',
      'admit:control_recovery',
      'mutate',
    ]);
  });

  it('rejects new AI work before orchestration or any durable/provider side effect', async () => {
    const orchestration = { preparePersistentTurn: jest.fn() };
    const admission = {
      admit: jest.fn((policy: string) => {
        if (policy === 'ai_new_work') throw new RateLimitError();
      }),
    };
    const turns = { findByClientRequestId: jest.fn().mockResolvedValue(null) };
    const controller = new AiController(
      orchestration as never,
      {} as never,
      admission as never,
      turns as never,
    );
    await expect(
      controller.streamChat(
        {
          authenticatedSession: { userId: 'user-1', id: 'session-1' },
        } as never,
        {} as never,
        undefined,
        {
          mode: 'persistent',
          clientRequestId: '11111111-1111-4111-8111-111111111111',
          message: 'synthetic message',
        },
      ),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(admission.admit.mock.calls.map(([policy]) => policy)).toEqual([
      'classification_probe',
      'ai_new_work',
    ]);
    expect(turns.findByClientRequestId).toHaveBeenCalledTimes(1);
    expect(orchestration.preparePersistentTurn).not.toHaveBeenCalled();
  });

  it('maps existing active-execution saturation to the bounded public rate-limit boundary', async () => {
    const response = {
      vary: jest.fn(),
      once: jest.fn(),
      removeListener: jest.fn(),
      destroyed: false,
      writableEnded: false,
    };
    const orchestration = {
      preparePersistentTurn: jest
        .fn()
        .mockRejectedValue(new ActiveAiExecutionCapacityError('global_limit')),
    };
    const admission = {
      admit: jest.fn(),
      rejectConcurrency: jest.fn(() => {
        throw new RateLimitError();
      }),
    };
    const turns = { findByClientRequestId: jest.fn().mockResolvedValue({ id: 'turn-1' }) };
    const controller = new AiController(
      orchestration as never,
      {} as never,
      admission as never,
      turns as never,
    );
    await expect(
      controller.streamChat(
        { authenticatedSession: { userId: 'user-1', id: 'session-1' } } as never,
        response as never,
        undefined,
        {
          mode: 'persistent',
          clientRequestId: '11111111-1111-4111-8111-111111111111',
          conversationId: '22222222-2222-4222-8222-222222222222',
          message: 'synthetic message',
        },
      ),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(admission.rejectConcurrency).toHaveBeenCalledWith('ai_new_work', 'user');
  });

  it('binds creation, recovery, mixed, and Staff routes to server-owned policy metadata', () => {
    const metadata = (target: object, key: symbol) => Reflect.getMetadata(key, target);
    expect(metadata(AuthController.prototype.register, HTTP_INGRESS_METADATA)).toMatchObject({
      lane: 'standard',
      additionalPolicies: ['registration'],
    });
    expect(metadata(AuthController.prototype.logout, HTTP_INGRESS_METADATA)).toMatchObject({
      lane: 'control',
    });
    expect(metadata(ConsentsController.prototype.mutate, HTTP_INGRESS_METADATA)).toMatchObject({
      lane: 'mixed',
    });
    expect(metadata(AiController.prototype.streamChat, HTTP_PRINCIPAL_METADATA)).toMatchObject({
      policy: 'manual',
      identityKind: 'user',
    });
    expect(
      metadata(IncognitoContextsController.prototype.create, HTTP_PRINCIPAL_METADATA),
    ).toMatchObject({ policy: 'ai_new_work' });
    expect(
      metadata(ConversationAccessController.prototype.listMessages, HTTP_INGRESS_METADATA),
    ).toMatchObject({ lane: 'control' });
    expect(
      metadata(MoodController.prototype.creationStatus, HTTP_PRINCIPAL_METADATA),
    ).toMatchObject({ policy: 'control_recovery' });
    expect(metadata(AdminController, HTTP_PRINCIPAL_METADATA)).toMatchObject({
      policy: 'staff_sensitive',
      identityKind: 'staff',
    });
    expect(metadata(AdminController.prototype.revokeRole, HTTP_PRINCIPAL_METADATA)).toMatchObject({
      policy: 'control_recovery',
      identityKind: 'staff',
    });
  });

  it('exposes Retry-After only through the existing allowlisted credentialed CORS policy', async () => {
    const delegate = createCorsOptions({
      WEB_ORIGINS: ['https://web.example.test'],
      ADMIN_WEB_ORIGINS: ['https://admin.example.test'],
    });
    const options = await new Promise<Record<string, unknown>>((resolve, reject) => {
      delegate(
        {
          originalUrl: '/quota',
          url: '/quota',
          headers: { origin: 'https://web.example.test' },
        } as never,
        (error, value) => (error ? reject(error) : resolve(value as Record<string, unknown>)),
      );
    });
    expect(options).toMatchObject({
      origin: 'https://web.example.test',
      credentials: true,
      exposedHeaders: ['X-MH-Knowledge-References', 'Retry-After'],
    });
  });

  describe('HTTP integration', () => {
    let app: INestApplication;
    let store: ProcessLocalTokenBucketStore;

    beforeEach(async () => {
      const testConfig = configuration({
        network_standard: { capacity: 5, refill: 1 },
        network_control: { capacity: 2, refill: 1 },
        public_read: { capacity: 1, refill: 0.5 },
        principal_general: { capacity: 1, refill: 0.5 },
      });
      const moduleRef = await Test.createTestingModule({
        controllers: [
          LimitedController,
          ReservedController,
          UnlimitedController,
          PrincipalController,
        ],
        providers: [
          Reflector,
          SyntheticAuthenticationGuard,
          { provide: HTTP_RATE_LIMIT_CONFIG, useValue: testConfig },
          { provide: MONOTONIC_CLOCK, useValue: { now: () => 0 } satisfies MonotonicClock },
          { provide: SecurityLoggingService, useValue: loggerDouble() },
          ProcessLocalTokenBucketStore,
          HttpAbuseAdmissionService,
          { provide: APP_GUARD, useClass: IngressRateLimitGuard },
          { provide: APP_INTERCEPTOR, useClass: PrincipalRateLimitInterceptor },
          { provide: APP_FILTER, useClass: AppExceptionFilter },
        ],
      }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
      store = app.get(ProcessLocalTokenBucketStore);
    });

    afterEach(async () => {
      await app.close();
    });

    it('returns the bounded 429 contract while reserved control and health stay usable', async () => {
      const server = app.getHttpServer();
      await request(server).get('/limited').expect(200);
      const denied = await request(server).get('/limited').expect(429);
      expect(denied.headers['retry-after']).toBe('2');
      expect(denied.headers['cache-control']).toBe('private, no-store');
      expect(denied.body).toEqual({
        success: false,
        error: { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后重试' },
      });
      await request(server).get('/reserved').expect(200);
      await request(server).get('/unlimited-health').expect(200);
      await request(server).get('/unlimited-health').expect(200);
      expect(store.size('network_control')).toBe(1);
    });

    it('isolates authenticated principal buckets without trusting a client policy marker', async () => {
      const server = app.getHttpServer();
      await request(server)
        .get('/principal')
        .set('x-synthetic-user', '00000000-0000-4000-8000-000000000001')
        .set('x-rate-limit-policy', 'control_recovery')
        .expect(200);
      await request(server)
        .get('/principal')
        .set('x-synthetic-user', '00000000-0000-4000-8000-000000000001')
        .set('x-rate-limit-policy', 'control_recovery')
        .expect(429);
      await request(server)
        .get('/principal')
        .set('x-synthetic-user', '00000000-0000-4000-8000-000000000002')
        .expect(200);
    });
  });
});

describe('application HTTP abuse protection wiring', () => {
  let app: INestApplication;
  let previousScale: number;

  beforeAll(async () => {
    previousScale = env.HTTP_RATE_LIMIT_CAPACITY_SCALE;
    env.HTTP_RATE_LIMIT_CAPACITY_SCALE = 1;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AppExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    env.HTTP_RATE_LIMIT_CAPACITY_SCALE = previousScale;
  });

  it('installs one early limiter and keeps the real health route outside it', async () => {
    const server = app.getHttpServer();
    for (let index = 0; index < 30; index += 1) {
      await request(server).get('/auth/registration-requirements').expect(200);
    }
    await request(server).get('/auth/registration-requirements').expect(429);
    await request(server).get('/health').expect(200);
    await request(server).get('/health').expect(200);
  });
});
