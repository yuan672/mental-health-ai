import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  createDatabaseClient,
  migrate,
  users,
  sessions,
  passwordCredentials,
  ageVerifications,
  diaryNotebooks,
  diaryPages,
  diaryAiTurnReferences,
  diaryAiGrants,
  diaryAiPolicies,
  auditLogs,
  eq,
  and,
} from '@mental-health/database';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { DiaryMemoryService } from '../src/diary/diary-memory.service';
import { diaryWindow } from '../src/diary/diary-memory.policy';
import { AppExceptionFilter } from '../src/common/filters/app-exception.filter';
import { hashSessionToken } from '../src/auth/sessions.service';
import { insertRequiredConsentFixtures } from './consent-fixtures';
import { AiOrchestrationService } from '../src/ai/ai-orchestration.service';
import { IncognitoContextsService } from '../src/ai/incognito/incognito-contexts.service';
import {
  LLM_PROVIDER,
  type LLMChatRequest,
  type LLMCallOptions,
  type LLMProviderStreamEvent,
} from '../src/ai/providers/llm-provider';
import {
  PRE_GENERATION_SAFETY_GATE,
  POST_GENERATION_SAFETY_GATE,
  PassThroughPreGenerationSafetyGate,
  PassThroughPostGenerationSafetyGate,
} from '../src/ai/safety/safety-gates';

const signal = () => new AbortController().signal;
const content = (body: string) => ({
  title: '合成日记',
  body,
  mood: 'happy' as const,
  weather: 'sun' as const,
  photoIds: [] as string[],
});
type Auth = { userId: string; sessionId: string; cookie: string; csrf: string };
describe('Private diary permissions and chat dispatch (synthetic data only)', () => {
  let app: INestApplication,
    db: DatabaseService,
    memory: DiaryMemoryService,
    ai: AiOrchestrationService;
  let client: ReturnType<typeof createDatabaseClient>;
  const captures: LLMChatRequest[] = [];
  const preGate = new PassThroughPreGenerationSafetyGate();
  const provider = {
    async *streamChat(
      input: LLMChatRequest,
      options: LLMCallOptions,
    ): AsyncIterable<LLMProviderStreamEvent> {
      await options.startTransport((s) => {
        s.throwIfAborted();
        return undefined;
      });
      captures.push(input);
      yield {
        type: 'started',
        metadata: { provider: 'fake', model: 'synthetic', requestId: null },
      };
      yield { type: 'text_delta', text: '合成的安全回复。' };
      yield {
        type: 'completed',
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
        metadata: { provider: 'fake', model: 'synthetic', requestId: null },
      };
    },
  };
  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url || !new URL(url).pathname.endsWith('_test'))
      throw new Error('Isolated test database required');
    client = createDatabaseClient(url);
    await migrate(client.database, {
      migrationsFolder: resolve(process.cwd(), '../../database/migrations'),
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LLM_PROVIDER)
      .useValue(provider)
      .overrideProvider(PRE_GENERATION_SAFETY_GATE)
      .useValue(preGate)
      .overrideProvider(POST_GENERATION_SAFETY_GATE)
      .useClass(PassThroughPostGenerationSafetyGate)
      .compile();
    app = module.createNestApplication();
    app.useLogger(false);
    app.useGlobalFilters(new AppExceptionFilter());
    await app.init();
    db = module.get(DatabaseService);
    memory = module.get(DiaryMemoryService);
    ai = module.get(AiOrchestrationService);
  }, 60000);
  afterAll(async () => {
    if (app) await app.close();
    if (client) await client.pool.end();
  });
  beforeEach(() => {
    captures.length = 0;
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  async function auth(): Promise<Auth> {
    const userId = randomUUID(),
      sessionId = randomUUID(),
      token = randomBytes(32).toString('base64url'),
      csrf = randomBytes(32).toString('base64url');
    await db.database.insert(users).values({ id: userId });
    await db.database
      .insert(passwordCredentials)
      .values({ userId, email: `${userId}@example.test`, passwordHash: 'synthetic' });
    await db.database.insert(ageVerifications).values({
      userId,
      ageVerified: true,
      verificationMethod: 'synthetic',
      verifiedAt: new Date(),
    });
    await db.database.insert(sessions).values({
      id: sessionId,
      userId,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() + 86400000),
    });
    await insertRequiredConsentFixtures(db.database, userId, new Date());
    return { userId, sessionId, csrf, cookie: `mh_session=${token}; mh_csrf=${csrf}` };
  }
  const req = (a: Auth, method: 'get' | 'patch', path: string) => {
    const agent = request(app.getHttpServer());
    return agent[method](path)
      .set('Cookie', a.cookie)
      .set('Origin', 'http://localhost:5173')
      .set('x-csrf-token', a.csrf);
  };
  async function book(a: Auth, body = '合成陶艺课程', day = diaryWindow().today) {
    const id = randomUUID();
    await db.database
      .insert(diaryNotebooks)
      .values({ id, userId: a.userId, name: '合成书本名称不外发' });
    await db.database.insert(diaryPages).values({
      notebookId: id,
      day,
      saved: content(body),
      draft: content('SYNTHETIC_PRIVATE_DRAFT'),
    });
    return id;
  }
  async function enable(a: Auth, mode: 'none' | 'selected' | 'all', notebookIds: string[] = []) {
    return memory.updatePolicy(a.userId, {
      mode,
      notebookIds,
      expectedRevision: (await memory.policy(a.userId)).revision,
    });
  }
  async function prepare(a: Auth, skip = false) {
    return ai.preparePersistentTurn(
      a,
      {
        clientRequestId: randomUUID(),
        message: '今天想聊聊陶艺课程',
        ...(skip ? { diaryAccess: 'skip' as const } : {}),
      },
      signal(),
    );
  }
  async function collect(p: Awaited<ReturnType<typeof prepare>>) {
    if (p.kind !== 'ready') throw new Error('Expected ready synthetic turn');
    const events = [];
    for await (const event of ai.streamPreparedTurn(p, signal())) events.push(event);
    return events;
  }
  it('defaults closed, enforces login, CSRF, ownership, CAS and audited policy writes', async () => {
    const a = await auth(),
      b = await auth(),
      id = await book(a);
    await request(app.getHttpServer()).get('/diary/ai/access').expect(401);
    expect((await req(a, 'get', '/diary/ai/access').expect(200)).body.data.policy).toEqual({
      mode: 'none',
      revision: 0,
      notebookIds: [],
    });
    await request(app.getHttpServer())
      .patch('/diary/ai/access')
      .set('Cookie', a.cookie)
      .send({ mode: 'all', notebookIds: [], expectedRevision: 0 })
      .expect(403);
    await req(b, 'patch', '/diary/ai/access')
      .send({ mode: 'selected', notebookIds: [id], expectedRevision: 0 })
      .expect(404);
    await req(a, 'patch', '/diary/ai/access')
      .send({ mode: 'selected', notebookIds: [id], expectedRevision: 0 })
      .expect(200);
    await req(a, 'patch', '/diary/ai/access')
      .send({ mode: 'all', notebookIds: [], expectedRevision: 0 })
      .expect(409);
    expect((await req(b, 'get', '/diary/ai/access')).body.data.policy.mode).toBe('none');
    const audits = await db.database
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.actorId, a.userId), eq(auditLogs.action, 'diary_ai_access_changed')));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.safeMetadata).toEqual({});
  });
  it('isolates selected books, excludes drafts/photos/old days, and all includes future books', async () => {
    const a = await auth(),
      b = await auth(),
      chosen = await book(a),
      other = await book(a, 'UNSELECTED');
    await book(b, 'OTHER_ACCOUNT');
    await book(a, 'OLD_DAY', '2020-01-01');
    const draftOnly = await book(a, 'draft placeholder');
    await db.database
      .update(diaryPages)
      .set({ saved: null })
      .where(eq(diaryPages.notebookId, draftOnly));
    const photoOnly = await book(a, '');
    expect(await memory.retrieve(a.userId, '陶艺', signal())).toBeNull();
    await enable(a, 'selected', [chosen]);
    const future = await book(a, 'NEW_BOOK');
    const selected = await memory.retrieve(a.userId, '陶艺', signal());
    expect(selected!.entries.map((e) => e.notebookId)).toEqual([chosen]);
    expect(JSON.stringify(selected)).not.toContain('SYNTHETIC_PRIVATE_DRAFT');
    expect(JSON.stringify(selected)).not.toContain('photoIds');
    await enable(a, 'all');
    expect(
      (await memory.retrieve(a.userId, '陶艺', signal()))!.entries.map((e) => e.notebookId).sort(),
    ).toEqual([chosen, other, future].sort());
    expect(
      (await memory.retrieve(a.userId, '陶艺', signal()))!.entries.some(
        (e) => e.notebookId === photoOnly,
      ),
    ).toBe(false);
    await enable(a, 'selected', [chosen]);
    await db.database.delete(diaryNotebooks).where(eq(diaryNotebooks.id, chosen));
    expect(await memory.retrieve(a.userId, '陶艺', signal())).toBeNull();
    expect(
      await db.database.select().from(diaryAiGrants).where(eq(diaryAiGrants.userId, a.userId)),
    ).toEqual([]);
  });
  it('rejects stale permissions, edits, deleted pages, day rollover and aborted dispatch', async () => {
    const a = await auth(),
      id = await book(a);
    await enable(a, 'all');
    const bundle = await memory.retrieve(a.userId, '陶艺', signal());
    await expect(memory.recheck(bundle, signal())).resolves.toBeUndefined();
    await enable(a, 'none');
    await expect(memory.recheck(bundle, signal())).rejects.toThrow('权限已改变');
    await enable(a, 'all');
    const fresh = await memory.retrieve(a.userId, '陶艺', signal());
    await db.database
      .update(diaryPages)
      .set({ saved: content('CHANGED'), revision: 2 })
      .where(eq(diaryPages.notebookId, id));
    await expect(memory.recheck(fresh, signal())).rejects.toThrow('修改或删除');
    const latest = await memory.retrieve(a.userId, '陶艺', signal());
    const abort = new AbortController();
    abort.abort();
    await expect(memory.recheck(latest, abort.signal)).rejects.toThrow();
    await expect(
      memory.recheck(latest, signal(), new Date(Date.now() + 8 * 86400000)),
    ).rejects.toThrow('范围已改变');
    await db.database.delete(diaryPages).where(eq(diaryPages.notebookId, id));
    await expect(memory.recheck(latest, signal())).rejects.toThrow('修改或删除');
  });
  it('provides only authorized text in real orchestration and records owner-only references after dispatch', async () => {
    const a = await auth(),
      b = await auth(),
      id = await book(a);
    await book(b, 'OTHER_ACCOUNT');
    await enable(a, 'selected', [id]);
    const p = await prepare(a);
    const events = await collect(p);
    expect(events.at(-1)!.type).toBe('turn.completed');
    expect(captures).toHaveLength(1);
    const sent = JSON.stringify(captures[0]);
    expect(sent).toContain('untrustedPrivateDiary');
    expect(sent).toContain('合成陶艺课程');
    for (const excluded of ['SYNTHETIC_PRIVATE_DRAFT', '合成书本名称不外发', 'OTHER_ACCOUNT', id])
      expect(sent).not.toContain(excluded);
    const turnId = p.turn.id;
    expect(
      (await req(a, 'get', `/diary/ai/turns/${turnId}`).expect(200)).body.data.entries[0],
    ).toMatchObject({ notebookId: id, available: true });
    await req(b, 'get', `/diary/ai/turns/${turnId}`).expect(404);
    const record = await db.database
      .select()
      .from(diaryAiTurnReferences)
      .where(eq(diaryAiTurnReferences.turnId, turnId));
    expect(Object.keys(record[0]!.entries[0]!).sort()).toEqual(['day', 'notebookId', 'revision']);
    await db.database.delete(diaryPages).where(eq(diaryPages.notebookId, id));
    expect((await memory.references(a.userId, turnId)).entries[0]).toMatchObject({
      available: false,
      title: '日记已修改或删除',
    });
    await db.database.delete(users).where(eq(users.id, a.userId));
    expect(
      await db.database
        .select()
        .from(diaryAiTurnReferences)
        .where(eq(diaryAiTurnReferences.turnId, turnId)),
    ).toEqual([]);
    expect(
      await db.database.select().from(diaryAiPolicies).where(eq(diaryAiPolicies.userId, a.userId)),
    ).toEqual([]);
    expect(
      await db.database.select().from(diaryAiGrants).where(eq(diaryAiGrants.userId, a.userId)),
    ).toEqual([]);
  });
  it('skips retrieval for default closed, this-turn skip, and high-risk routing', async () => {
    const a = await auth();
    await book(a);
    await collect(await prepare(a));
    expect(JSON.stringify(captures)).not.toContain('untrustedPrivateDiary');
    await enable(a, 'all');
    const spy = jest.spyOn(memory, 'retrieve');
    await collect(await prepare(a, true));
    expect(spy).not.toHaveBeenCalled();
    const low = await preGate.check({} as never, signal(), {} as never);
    if (low.status !== 'assessed') throw new Error('Synthetic risk gate expected assessed');
    jest.spyOn(preGate, 'check').mockResolvedValue({
      ...low,
      level: 'HIGH',
      route: 'ALLOW_WITH_SAFETY_INSTRUCTION',
      bufferingMode: 'full',
    });
    await collect(await prepare(a));
    expect(spy).not.toHaveBeenCalled();
  });
  it('blocks provider dispatch when permissions change after turn preparation', async () => {
    const a = await auth();
    await book(a);
    await enable(a, 'all');
    const p = await prepare(a);
    await enable(a, 'none');
    await expect(collect(p)).rejects.toThrow();
    expect(captures).toHaveLength(0);
    expect(await memory.references(a.userId, p.turn.id)).toEqual({ recorded: false, entries: [] });
  });
  it('never retrieves private diaries for incognito conversations', async () => {
    const a = await auth();
    await book(a);
    await enable(a, 'all');
    const context = await app.get(IncognitoContextsService).create({
      id: a.sessionId,
      userId: a.userId,
      expiresAt: new Date(Date.now() + 86400000),
      revokedAt: null,
    });
    const spy = jest.spyOn(memory, 'retrieve');
    const p = await ai.prepareIncognitoTurn(
      a,
      {
        mode: 'incognito',
        contextId: context.id,
        clientRequestId: randomUUID(),
        message: '合成聊天',
      },
      signal(),
    );
    if (p.kind !== 'ready') throw new Error('Expected ready incognito turn');
    for await (const event of ai.streamPreparedIncognitoTurn(p, signal())) {
      void event;
    }
    expect(spy).not.toHaveBeenCalled();
    expect(JSON.stringify(captures)).not.toContain('untrustedPrivateDiary');
  });
});
