import { randomBytes, randomUUID } from 'node:crypto';
import {
  ageVerifications,
  auditLogs,
  count,
  createDatabaseClient,
  eq,
  migrate,
  moodEntries,
  passwordCredentials,
  riskEvents,
  sessions,
  users,
} from '@mental-health/database';
import { Injectable, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { resolve } from 'node:path';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { hashSessionToken } from '../src/auth/sessions.service';
import { AppExceptionFilter } from '../src/common/filters/app-exception.filter';
import { decodeOpaqueCursor, encodeOpaqueCursor } from '../src/common/pagination/opaque-cursor';
import { DatabaseService } from '../src/database/database.service';
import { MoodRepository } from '../src/mood/mood.repository';
import { MoodService } from '../src/mood/mood.service';
import {
  createMoodEntryResponseSchema,
  moodCreationStatusResponseSchema,
  moodHistoryCursorSchema,
  moodHistoryResponseSchema,
} from '../src/mood/mood.schemas';
import { AuditLogRepository } from '../src/safety/audit/audit-log.repository';
import { profileResponseSchema } from '../src/profile/profile.schemas';

const WEB_ORIGIN = 'http://localhost:5173';
const DAY_MS = 86_400_000;

type AuthContext = Readonly<{
  userId: string;
  cookie: string;
  csrfToken: string;
  email: string;
  createdAt: Date;
  verifiedAt: Date;
}>;

type Deferred = Readonly<{
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}>;

function createDeferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function withTimeout<T>(
  promise: PromiseLike<T>,
  label: string,
  timeoutMs = 5_000,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

@Injectable()
class ObservableMoodRepository extends MoodRepository {
  private historyEntriesReadHook: (() => Promise<void>) | null = null;

  constructor(audits: AuditLogRepository, database: DatabaseService) {
    super(audits, database);
  }

  setHistoryEntriesReadHook(hook: (() => Promise<void>) | null): void {
    this.historyEntriesReadHook = hook;
  }

  protected override async afterHistoryEntriesRead(): Promise<void> {
    await this.historyEntriesReadHook?.();
  }
}

describe('Phase 5D-1 Mood and Profile backend integration', () => {
  let app: INestApplication;
  let migrationClient: ReturnType<typeof createDatabaseClient>;
  let database: DatabaseService;
  let moodService: MoodService;
  let moodRepository: ObservableMoodRepository;
  let audits: AuditLogRepository;

  beforeAll(async () => {
    const testDatabaseUrl = process.env.TEST_DATABASE_URL;
    if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL is required for integration tests');
    const databaseName = decodeURIComponent(new URL(testDatabaseUrl).pathname.slice(1));
    if (!databaseName.endsWith('_test')) {
      throw new Error('Integration tests refuse to reset a database without an _test suffix');
    }

    migrationClient = createDatabaseClient(testDatabaseUrl);
    await migrationClient.pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await migrationClient.pool.query('DROP SCHEMA public CASCADE');
    await migrationClient.pool.query('CREATE SCHEMA public');
    await migrate(migrationClient.database, {
      migrationsFolder: resolve(process.cwd(), '../../database/migrations'),
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MoodRepository)
      .useClass(ObservableMoodRepository)
      .compile();
    app = moduleRef.createNestApplication();
    app.useLogger(false);
    app.useGlobalFilters(new AppExceptionFilter());
    await app.init();
    database = moduleRef.get(DatabaseService);
    moodService = moduleRef.get(MoodService);
    moodRepository = moduleRef.get(MoodRepository);
    audits = moduleRef.get(AuditLogRepository);
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
    if (migrationClient) await migrationClient.pool.end();
  });

  async function createAuthContext(): Promise<AuthContext> {
    const userId = randomUUID();
    const rawToken = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const email = `mood-${randomUUID()}@example.test`;
    const createdAt = new Date('2026-09-01T02:03:04.000Z');
    const verifiedAt = new Date('2026-09-01T02:04:05.000Z');
    await database.database.insert(users).values({ id: userId, createdAt });
    await database.database.insert(passwordCredentials).values({
      userId,
      email,
      passwordHash: 'synthetic-password-hash-not-returned',
      createdAt,
    });
    await database.database.insert(ageVerifications).values({
      userId,
      ageVerified: true,
      verificationMethod: 'synthetic-test-method',
      verifiedAt,
    });
    await database.database.insert(sessions).values({
      id: randomUUID(),
      userId,
      tokenHash: hashSessionToken(rawToken),
      createdAt,
      expiresAt: new Date(Date.now() + 7 * DAY_MS),
      revokedAt: null,
    });
    return {
      userId,
      cookie: `mh_session=${rawToken}; mh_csrf=${csrfToken}`,
      csrfToken,
      email,
      createdAt,
      verifiedAt,
    };
  }

  function get(auth: AuthContext, path: string) {
    return request(app.getHttpServer()).get(path).set('Cookie', auth.cookie);
  }

  function post(auth: AuthContext, path: string) {
    return request(app.getHttpServer())
      .post(path)
      .set('Cookie', auth.cookie)
      .set('Origin', WEB_ORIGIN)
      .set('x-csrf-token', auth.csrfToken);
  }

  function patchRequest(auth: AuthContext, path: string) {
    return request(app.getHttpServer())
      .patch(path)
      .set('Cookie', auth.cookie)
      .set('Origin', WEB_ORIGIN)
      .set('x-csrf-token', auth.csrfToken);
  }

  function deleteRequest(auth: AuthContext, path: string) {
    return request(app.getHttpServer())
      .delete(path)
      .set('Cookie', auth.cookie)
      .set('Origin', WEB_ORIGIN)
      .set('x-csrf-token', auth.csrfToken);
  }

  async function waitForBlockedMoodQuery(label: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const waiting = await migrationClient.pool.query<{ found: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM pg_stat_activity
           WHERE datname = current_database()
             AND pid <> pg_backend_pid()
             AND wait_event_type = 'Lock'
             AND query ILIKE '%mood_entries%'
         ) AS found`,
      );
      if (waiting.rows[0]?.found) return;
      await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
    }
    throw new Error(`${label}: no blocked Mood query was observed`);
  }

  it('requires Session and CSRF while remaining independent of AI Consent and quota', async () => {
    await request(app.getHttpServer()).get('/profile').expect(401);
    await request(app.getHttpServer()).get('/mood-entries').expect(401);

    const auth = await createAuthContext();
    await request(app.getHttpServer())
      .post('/mood-entries')
      .set('Cookie', auth.cookie)
      .send({ clientRequestId: randomUUID(), moodScore: 3 })
      .expect(403);

    const created = await post(auth, '/mood-entries')
      .send({ clientRequestId: randomUUID(), moodScore: 3, emotion: null, note: null })
      .expect('Cache-Control', 'private, no-store')
      .expect(201);
    expect(createMoodEntryResponseSchema.parse(created.body).data.disposition).toBe('created');

    const profile = await get(auth, '/profile')
      .expect('Cache-Control', 'private, no-store')
      .expect(200);
    expect(profileResponseSchema.parse(profile.body)).toEqual({
      success: true,
      data: {
        email: auth.email,
        accountCreatedAt: auth.createdAt.toISOString(),
        adultEligibility: { verified: true, verifiedAt: auth.verifiedAt.toISOString() },
      },
    });
    expect(JSON.stringify(profile.body)).not.toMatch(/userId|password|method|evidence|session/iu);
  });

  it('enforces strict fields and the 500 Unicode-code-point note boundary', async () => {
    const auth = await createAuthContext();
    const fiveHundredEmoji = '🙂'.repeat(500);
    const accepted = await post(auth, '/mood-entries')
      .send({
        clientRequestId: randomUUID(),
        moodScore: 5,
        emotion: 'joyful',
        note: `  ${fiveHundredEmoji}  `,
      })
      .expect(201);
    expect(Array.from(accepted.body.data.entry.note as string)).toHaveLength(500);

    await post(auth, '/mood-entries')
      .send({ clientRequestId: randomUUID(), moodScore: 3, note: '🙂'.repeat(501) })
      .expect(400);
    await post(auth, '/mood-entries')
      .send({ clientRequestId: randomUUID(), moodScore: 0 })
      .expect(400);
    await post(auth, '/mood-entries')
      .send({ clientRequestId: randomUUID(), moodScore: 3, emotion: 'diagnosed' })
      .expect(400);
    await post(auth, '/mood-entries')
      .send({ clientRequestId: randomUUID(), moodScore: 3, extra: true })
      .expect(400);

    const combining = 'e\u0301'.repeat(250);
    await post(auth, '/mood-entries')
      .send({ clientRequestId: randomUUID(), moodScore: 4, note: combining })
      .expect(201);
    await post(auth, '/mood-entries')
      .send({ clientRequestId: randomUUID(), moodScore: 4, note: `${combining}e` })
      .expect(400);
  });

  it('converges concurrent creates and returns the current edited row without applying a retry payload', async () => {
    const auth = await createAuthContext();
    const clientRequestId = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        moodService.create(auth.userId, {
          clientRequestId,
          moodScore: index === 0 ? 1 : 5,
          emotion: index === 0 ? 'sad' : 'joyful',
          note: `synthetic-${index}`,
        }),
      ),
    );
    expect(responses.filter((response) => response.data.disposition === 'created')).toHaveLength(1);
    const rows = await database.database
      .select()
      .from(moodEntries)
      .where(eq(moodEntries.clientRequestId, clientRequestId));
    expect(rows).toHaveLength(1);
    const original = rows[0]!;

    const edited = await patchRequest(auth, `/mood-entries/${original.id}`)
      .send({
        expectedRevision: 1,
        moodScore: 2,
        emotion: 'calm',
        note: 'edited-current-state',
      })
      .expect(200);
    expect(edited.body.data.entry.stateRevision).toBe(2);

    const replay = await post(auth, '/mood-entries')
      .send({ clientRequestId, moodScore: 5, emotion: 'angry', note: 'must-not-apply' })
      .expect(201);
    expect(replay.body.data).toEqual({
      disposition: 'existing',
      entry: edited.body.data.entry,
    });

    const other = await createAuthContext();
    await post(other, '/mood-entries')
      .send({ clientRequestId, moodScore: 4, emotion: null, note: null })
      .expect(201);
    const crossUserRows = await database.database
      .select()
      .from(moodEntries)
      .where(eq(moodEntries.clientRequestId, clientRequestId));
    expect(crossUserRows).toHaveLength(2);
  });

  it('holds a real unique-key conflict until the first create transaction commits', async () => {
    const auth = await createAuthContext();
    const clientRequestId = randomUUID();
    const first = await migrationClient.pool.connect();
    const second = await migrationClient.pool.connect();
    try {
      await first.query('BEGIN');
      await second.query('BEGIN');
      const now = new Date();
      const values = [auth.userId, clientRequestId, now];
      const backend = await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const secondBackendPid = backend.rows[0]?.pid;
      expect(secondBackendPid).toEqual(expect.any(Number));
      await first.query(
        `INSERT INTO mood_entries
         (id, user_id, client_request_id, mood_score, emotion, note,
          state_revision, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 3, NULL, NULL, 1, $3, $3)`,
        values,
      );

      const competingInsert = second.query(
        `INSERT INTO mood_entries
         (id, user_id, client_request_id, mood_score, emotion, note,
          state_revision, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 5, 'joyful', 'ignored', 1, $3, $3)
         ON CONFLICT (user_id, client_request_id) DO NOTHING
         RETURNING id`,
        values,
      );

      let observedLockWait = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const activity = await migrationClient.pool.query<{ wait_event_type: string | null }>(
          'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
          [secondBackendPid],
        );
        if (activity.rows[0]?.wait_event_type === 'Lock') {
          observedLockWait = true;
          break;
        }
        await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
      }
      expect(observedLockWait).toBe(true);

      await first.query('COMMIT');
      const loser = await competingInsert;
      expect(loser.rowCount).toBe(0);
      await second.query('COMMIT');

      const stored = await database.database
        .select()
        .from(moodEntries)
        .where(eq(moodEntries.clientRequestId, clientRequestId));
      expect(stored).toHaveLength(1);
      expect(stored[0]?.moodScore).toBe(3);
    } finally {
      await Promise.allSettled([first.query('ROLLBACK'), second.query('ROLLBACK')]);
      first.release();
      second.release();
    }
  });

  it('reports creation status as a point-in-time owner-scoped read, including an uncommitted create', async () => {
    const auth = await createAuthContext();
    const other = await createAuthContext();
    const clientRequestId = randomUUID();
    const id = randomUUID();
    const transaction = await migrationClient.pool.connect();
    try {
      await transaction.query('BEGIN');
      await transaction.query(
        `INSERT INTO mood_entries
         (id, user_id, client_request_id, mood_score, emotion, note,
          state_revision, created_at, updated_at)
         VALUES ($1, $2, $3, 3, NULL, NULL, 1, $4, $4)`,
        [id, auth.userId, clientRequestId, new Date()],
      );

      const absentWhilePending = await get(
        auth,
        `/mood-entries/creation-status/${clientRequestId}`,
      ).expect(200);
      expect(moodCreationStatusResponseSchema.parse(absentWhilePending.body).data).toEqual({
        status: 'absent',
      });
      await transaction.query('COMMIT');

      const present = await get(auth, `/mood-entries/creation-status/${clientRequestId}`).expect(
        200,
      );
      expect(present.body.data.status).toBe('present');
      expect(present.body.data.entry.id).toBe(id);
      const isolated = await get(other, `/mood-entries/creation-status/${clientRequestId}`).expect(
        200,
      );
      expect(isolated.body.data).toEqual({ status: 'absent' });

      await deleteRequest(auth, `/mood-entries/${id}`).send({ expectedRevision: 1 }).expect(200);
      const absentAfterDelete = await get(
        auth,
        `/mood-entries/creation-status/${clientRequestId}`,
      ).expect(200);
      expect(absentAfterDelete.body.data).toEqual({ status: 'absent' });
    } finally {
      try {
        await transaction.query('ROLLBACK');
      } finally {
        transaction.release();
      }
    }
  });

  it('uses fixed Asia/Shanghai bounds, a creation ceiling, ordering, pagination, and full trend', async () => {
    const auth = await createAuthContext();
    const now = new Date('2026-09-11T15:59:59.000Z');
    const fixtures = [
      { at: '2026-09-04T15:59:59.000Z', score: 5 },
      { at: '2026-09-04T16:00:00.000Z', score: 1 },
      { at: '2026-09-10T02:00:00.000Z', score: 3 },
      { at: '2026-09-10T03:00:00.000Z', score: 5 },
      { at: '2026-09-11T15:00:00.000Z', score: 4 },
      { at: '2026-09-11T15:59:59.500Z', score: 2 },
      { at: '2026-09-11T16:00:00.000Z', score: 1 },
    ];
    for (const fixture of fixtures) {
      const timestamp = new Date(fixture.at);
      await database.database.insert(moodEntries).values({
        id: randomUUID(),
        userId: auth.userId,
        clientRequestId: randomUUID(),
        moodScore: fixture.score,
        emotion: null,
        note: null,
        stateRevision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }

    const first = moodHistoryResponseSchema.parse(
      await moodService.list(auth.userId, { days: 7, limit: 2 }, now),
    );
    expect(first.data.period).toEqual({ startDate: '2026-09-05', endDate: '2026-09-11' });
    expect(first.data.entries.map((entry) => entry.moodScore)).toEqual([4, 5]);
    expect(first.data.dailyTrend).toEqual([
      { localDate: '2026-09-05', entryCount: 1, averageMoodScore: 1 },
      { localDate: '2026-09-10', entryCount: 2, averageMoodScore: 4 },
      { localDate: '2026-09-11', entryCount: 1, averageMoodScore: 4 },
    ]);
    expect(first.data.nextCursor).toEqual(expect.any(String));

    const second = moodHistoryResponseSchema.parse(
      await moodService.list(
        auth.userId,
        { days: 7, limit: 2, cursor: first.data.nextCursor ?? undefined },
        new Date('2026-09-12T04:00:00.000Z'),
      ),
    );
    expect(second.data.period).toEqual(first.data.period);
    expect(second.data.entries.map((entry) => entry.moodScore)).toEqual([3, 1]);
    expect(second.data.dailyTrend).toEqual(first.data.dailyTrend);

    const thirtyDays = moodHistoryResponseSchema.parse(
      await moodService.list(auth.userId, { days: 30, limit: 100 }, now),
    );
    expect(thirtyDays.data.entries).toHaveLength(5);
    expect(thirtyDays.data.period).toEqual({ startDate: '2026-08-13', endDate: '2026-09-11' });
  });

  it('rejects forged Mood windows before repository access', async () => {
    const auth = await createAuthContext();
    const now = new Date();
    for (const createdAt of [new Date(now.getTime() - 60_000), new Date(now.getTime() - 120_000)]) {
      await database.database.insert(moodEntries).values({
        id: randomUUID(),
        userId: auth.userId,
        clientRequestId: randomUUID(),
        moodScore: 3,
        emotion: null,
        note: null,
        stateRevision: 1,
        createdAt,
        updatedAt: createdAt,
      });
    }

    const first = moodHistoryResponseSchema.parse(
      await moodService.list(auth.userId, { days: 7, limit: 1 }, now),
    );
    const validCursor = decodeOpaqueCursor(
      first.data.nextCursor ?? undefined,
      moodHistoryCursorSchema,
    );
    expect(validCursor).not.toBeNull();

    const afterMidnight = moodHistoryResponseSchema.parse(
      await moodService.list(
        auth.userId,
        { days: 7, limit: 1, cursor: first.data.nextCursor ?? undefined },
        new Date(now.getTime() + DAY_MS),
      ),
    );
    expect(afterMidnight.data.period).toEqual(first.data.period);
    await get(
      auth,
      `/mood-entries?days=7&limit=1&cursor=${encodeURIComponent(first.data.nextCursor!)}`,
    ).expect(200);

    const cursor = validCursor!;
    const encode = (overrides: Partial<typeof cursor>): string =>
      encodeOpaqueCursor({ ...cursor, ...overrides });
    const invalidCursors = [
      encode({
        rangeStart: new Date(new Date(cursor.rangeStart).getTime() - 359 * DAY_MS).toISOString(),
      }),
      encode({
        rangeStart: new Date(new Date(cursor.rangeStart).getTime() + 60 * 60 * 1_000).toISOString(),
        rangeEnd: new Date(new Date(cursor.rangeEnd).getTime() + 60 * 60 * 1_000).toISOString(),
      }),
      encode({ createdAtCeiling: cursor.rangeEnd }),
      encode({
        rangeStart: new Date(new Date(cursor.rangeStart).getTime() + DAY_MS).toISOString(),
        rangeEnd: new Date(new Date(cursor.rangeEnd).getTime() + DAY_MS).toISOString(),
        createdAtCeiling: new Date(
          new Date(cursor.createdAtCeiling).getTime() + DAY_MS,
        ).toISOString(),
        createdAt: new Date(new Date(cursor.createdAt).getTime() + DAY_MS).toISOString(),
      }),
      encode({
        createdAt: new Date(new Date(cursor.rangeStart).getTime() - 1).toISOString(),
      }),
      encode({
        createdAt: new Date(new Date(cursor.createdAtCeiling).getTime() + 1).toISOString(),
      }),
      encode({ days: 30 }),
    ];

    const repositorySpy = jest.spyOn(moodRepository, 'listWithTrend');
    try {
      for (const invalidCursor of invalidCursors) {
        await get(
          auth,
          `/mood-entries?days=7&limit=1&cursor=${encodeURIComponent(invalidCursor)}`,
        ).expect(400);
      }
      expect(repositorySpy).not.toHaveBeenCalled();
    } finally {
      repositorySpy.mockRestore();
    }
  });

  it('applies optimistic revision and owner isolation to update and delete', async () => {
    const auth = await createAuthContext();
    const other = await createAuthContext();
    const created = await post(auth, '/mood-entries')
      .send({ clientRequestId: randomUUID(), moodScore: 2, emotion: 'tired', note: null })
      .expect(201);
    const id = created.body.data.entry.id as string;

    await get(other, `/mood-entries/${id}`).expect(404);
    await patchRequest(other, `/mood-entries/${id}`)
      .send({ expectedRevision: 1, moodScore: 4, emotion: null, note: null })
      .expect(404);
    await deleteRequest(other, `/mood-entries/${id}`).send({ expectedRevision: 1 }).expect(404);

    const noChange = await patchRequest(auth, `/mood-entries/${id}`)
      .send({ expectedRevision: 1, moodScore: 2, emotion: 'tired', note: null })
      .expect(200);
    expect(noChange.body.data.entry.stateRevision).toBe(1);

    const [first, second] = await Promise.all([
      patchRequest(auth, `/mood-entries/${id}`).send({
        expectedRevision: 1,
        moodScore: 3,
        emotion: 'calm',
        note: null,
      }),
      patchRequest(auth, `/mood-entries/${id}`).send({
        expectedRevision: 1,
        moodScore: 4,
        emotion: 'hopeful',
        note: null,
      }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect([first.body.error?.code, second.body.error?.code]).toContain('MOOD_STATE_CHANGED');

    await deleteRequest(auth, `/mood-entries/${id}`).send({ expectedRevision: 1 }).expect(409);
    const current = await get(auth, `/mood-entries/${id}`).expect(200);
    await deleteRequest(auth, `/mood-entries/${id}`)
      .send({ expectedRevision: current.body.data.entry.stateRevision })
      .expect(200);
    await get(auth, `/mood-entries/${id}`).expect(404);

    const audit = await database.database
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.idempotencyKey, `mood_entry_deleted:${auth.userId}:${id}`));
    expect(audit).toHaveLength(1);
    expect(audit[0]?.safeMetadata).toEqual({});
  });

  it('hard-deletes all owned entries using the database result and atomically audits positive counts', async () => {
    const auth = await createAuthContext();
    const other = await createAuthContext();
    for (const createdAt of [new Date(), new Date(Date.now() - 400 * DAY_MS)]) {
      await database.database.insert(moodEntries).values({
        id: randomUUID(),
        userId: auth.userId,
        clientRequestId: randomUUID(),
        moodScore: 3,
        emotion: null,
        note: 'must-not-enter-audit',
        stateRevision: 1,
        createdAt,
        updatedAt: createdAt,
      });
    }
    await database.database.insert(moodEntries).values({
      id: randomUUID(),
      userId: other.userId,
      clientRequestId: randomUUID(),
      moodScore: 4,
      emotion: null,
      note: null,
      stateRevision: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const deleted = await deleteRequest(auth, '/mood-entries').expect(200);
    expect(deleted.body.data).toEqual({ deleted: true, entryCount: 2 });
    const [ownedCount] = await database.database
      .select({ value: count() })
      .from(moodEntries)
      .where(eq(moodEntries.userId, auth.userId));
    const [otherCount] = await database.database
      .select({ value: count() })
      .from(moodEntries)
      .where(eq(moodEntries.userId, other.userId));
    expect(ownedCount?.value).toBe(0);
    expect(otherCount?.value).toBe(1);

    const historyAudits = await database.database
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'mood_history_deleted'));
    const relevant = historyAudits.filter((row) => row.actorId === auth.userId);
    expect(relevant).toHaveLength(1);
    expect(relevant[0]?.safeMetadata).toEqual({ entryCount: 2 });
    expect(JSON.stringify(relevant[0])).not.toContain('must-not-enter-audit');

    await deleteRequest(auth, '/mood-entries').expect(200, {
      success: true,
      data: { deleted: true, entryCount: 0 },
    });
    const afterZero = await database.database
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'mood_history_deleted'));
    expect(afterZero.filter((row) => row.actorId === auth.userId)).toHaveLength(1);
  });

  it('rolls a Mood deletion back when its content-free Audit append fails', async () => {
    const auth = await createAuthContext();
    const created = await post(auth, '/mood-entries')
      .send({ clientRequestId: randomUUID(), moodScore: 3, emotion: null, note: 'private-note' })
      .expect(201);
    const id = created.body.data.entry.id as string;
    const spy = jest
      .spyOn(audits, 'appendWithinTransaction')
      .mockRejectedValueOnce(new Error('synthetic audit failure'));
    try {
      await deleteRequest(auth, `/mood-entries/${id}`).send({ expectedRevision: 1 }).expect(500);
    } finally {
      spy.mockRestore();
    }
    await get(auth, `/mood-entries/${id}`).expect(200);
  });

  it('rolls delete-all back when its content-free Audit append fails', async () => {
    const auth = await createAuthContext();
    for (const score of [2, 4]) {
      await post(auth, '/mood-entries')
        .send({ clientRequestId: randomUUID(), moodScore: score })
        .expect(201);
    }
    const spy = jest
      .spyOn(audits, 'appendWithinTransaction')
      .mockRejectedValueOnce(new Error('synthetic audit failure'));
    try {
      await deleteRequest(auth, '/mood-entries').expect(500);
    } finally {
      spy.mockRestore();
    }
    const remaining = await database.database
      .select({ value: count() })
      .from(moodEntries)
      .where(eq(moodEntries.userId, auth.userId));
    expect(remaining[0]?.value).toBe(2);
  });

  it('excludes an inserted but uncommitted create from the delete-all visible set', async () => {
    const auth = await createAuthContext();
    const id = randomUUID();
    const clientRequestId = randomUUID();
    const creator = await migrationClient.pool.connect();
    try {
      await creator.query('BEGIN');
      const timestamp = new Date();
      await creator.query(
        `INSERT INTO mood_entries
         (id, user_id, client_request_id, mood_score, emotion, note,
          state_revision, created_at, updated_at)
         VALUES ($1, $2, $3, 3, NULL, NULL, 1, $4, $4)`,
        [id, auth.userId, clientRequestId, timestamp],
      );

      const deleted = await withTimeout(
        deleteRequest(auth, '/mood-entries'),
        'delete-all while create is uncommitted',
      );
      expect(deleted.status).toBe(200);
      expect(deleted.body.data.entryCount).toBe(0);
      const beforeCommitAudits = await database.database
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, 'mood_history_deleted'));
      expect(beforeCommitAudits.filter((row) => row.actorId === auth.userId)).toHaveLength(0);

      await creator.query('COMMIT');
      const status = await get(auth, `/mood-entries/creation-status/${clientRequestId}`).expect(
        200,
      );
      expect(status.body.data).toEqual(
        expect.objectContaining({ status: 'present', entry: expect.objectContaining({ id }) }),
      );
      const remaining = await database.database
        .select({ value: count() })
        .from(moodEntries)
        .where(eq(moodEntries.userId, auth.userId));
      expect(remaining[0]?.value).toBe(1);
    } finally {
      await creator.query('ROLLBACK').catch(() => undefined);
      creator.release();
    }
  });

  it('keeps update/delete ordering revision-safe in both real lock orders', async () => {
    const auth = await createAuthContext();
    const updateFirst = await post(auth, '/mood-entries')
      .send({ clientRequestId: randomUUID(), moodScore: 2, emotion: null, note: null })
      .expect(201);
    const updateFirstId = updateFirst.body.data.entry.id as string;
    const updater = await migrationClient.pool.connect();
    try {
      await updater.query('BEGIN');
      await updater.query(
        `UPDATE mood_entries
         SET mood_score = 4, state_revision = 2, updated_at = NOW()
         WHERE id = $1 AND user_id = $2 AND state_revision = 1`,
        [updateFirstId, auth.userId],
      );
      const losingDelete = withTimeout(
        deleteRequest(auth, `/mood-entries/${updateFirstId}`)
          .send({ expectedRevision: 1 })
          .then((response) => response),
        'delete waiting behind update',
      );
      await waitForBlockedMoodQuery('delete waiting behind update');
      await updater.query('COMMIT');
      const deleteResponse = await losingDelete;
      expect(deleteResponse.status).toBe(409);
      expect(deleteResponse.body.error.code).toBe('MOOD_STATE_CHANGED');
    } finally {
      await updater.query('ROLLBACK').catch(() => undefined);
      updater.release();
    }

    const updated = await get(auth, `/mood-entries/${updateFirstId}`).expect(200);
    expect(updated.body.data.entry).toEqual(
      expect.objectContaining({ moodScore: 4, stateRevision: 2 }),
    );
    const failedDeleteAudits = await database.database
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.idempotencyKey, `mood_entry_deleted:${auth.userId}:${updateFirstId}`));
    expect(failedDeleteAudits).toHaveLength(0);

    const deleteFirst = await post(auth, '/mood-entries')
      .send({ clientRequestId: randomUUID(), moodScore: 3, emotion: null, note: null })
      .expect(201);
    const deleteFirstId = deleteFirst.body.data.entry.id as string;
    const auditReached = createDeferred();
    const allowDeleteCommit = createDeferred();
    const originalAppend = audits.appendWithinTransaction.bind(audits);
    const auditSpy = jest
      .spyOn(audits, 'appendWithinTransaction')
      .mockImplementationOnce(async (transaction, input) => {
        await originalAppend(transaction, input);
        auditReached.resolve();
        await allowDeleteCommit.promise;
      });
    try {
      const winningDelete = withTimeout(
        deleteRequest(auth, `/mood-entries/${deleteFirstId}`)
          .send({ expectedRevision: 1 })
          .then((response) => response),
        'delete-first request',
      );
      await withTimeout(auditReached.promise, 'delete audit barrier');
      const losingUpdate = withTimeout(
        patchRequest(auth, `/mood-entries/${deleteFirstId}`)
          .send({ expectedRevision: 1, moodScore: 5, emotion: null, note: null })
          .then((response) => response),
        'update waiting behind delete',
      );
      await waitForBlockedMoodQuery('update waiting behind delete');
      allowDeleteCommit.resolve();
      const [deleteResponse, updateResponse] = await Promise.all([winningDelete, losingUpdate]);
      expect(deleteResponse.status).toBe(200);
      expect(updateResponse.status).toBe(404);
      await get(auth, `/mood-entries/${deleteFirstId}`).expect(404);
    } finally {
      allowDeleteCommit.resolve();
      auditSpy.mockRestore();
    }
    const successfulDeleteAudits = await database.database
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.idempotencyKey, `mood_entry_deleted:${auth.userId}:${deleteFirstId}`));
    expect(successfulDeleteAudits).toHaveLength(1);
  });

  it('does not let an update revive rows deleted by a real overlapping delete-all', async () => {
    const auth = await createAuthContext();
    const target = await post(auth, '/mood-entries')
      .send({ clientRequestId: randomUUID(), moodScore: 2, emotion: null, note: null })
      .expect(201);
    await post(auth, '/mood-entries')
      .send({ clientRequestId: randomUUID(), moodScore: 4, emotion: null, note: null })
      .expect(201);
    const targetId = target.body.data.entry.id as string;
    const auditReached = createDeferred();
    const allowDeleteCommit = createDeferred();
    const originalAppend = audits.appendWithinTransaction.bind(audits);
    const auditSpy = jest
      .spyOn(audits, 'appendWithinTransaction')
      .mockImplementationOnce(async (transaction, input) => {
        await originalAppend(transaction, input);
        auditReached.resolve();
        await allowDeleteCommit.promise;
      });
    try {
      const deleteAll = withTimeout(
        deleteRequest(auth, '/mood-entries').then((response) => response),
        'overlapping delete-all',
      );
      await withTimeout(auditReached.promise, 'delete-all audit barrier');
      const update = withTimeout(
        patchRequest(auth, `/mood-entries/${targetId}`)
          .send({ expectedRevision: 1, moodScore: 5, emotion: null, note: null })
          .then((response) => response),
        'update waiting behind delete-all',
      );
      await waitForBlockedMoodQuery('update waiting behind delete-all');
      allowDeleteCommit.resolve();
      const [deleteResponse, updateResponse] = await Promise.all([deleteAll, update]);
      expect(deleteResponse.status).toBe(200);
      expect(deleteResponse.body.data.entryCount).toBe(2);
      expect(updateResponse.status).toBe(404);
    } finally {
      allowDeleteCommit.resolve();
      auditSpy.mockRestore();
    }

    const remaining = await database.database
      .select({ value: count() })
      .from(moodEntries)
      .where(eq(moodEntries.userId, auth.userId));
    expect(remaining[0]?.value).toBe(0);
    const historyAudits = await database.database
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'mood_history_deleted'));
    const relevant = historyAudits.filter((row) => row.actorId === auth.userId);
    expect(relevant).toHaveLength(1);
    expect(relevant[0]?.safeMetadata).toEqual({ entryCount: 2 });
  });

  it('reads entries and trend from one repeatable-read view across a concurrent edit', async () => {
    const auth = await createAuthContext();
    const createdAt = new Date('2026-09-11T01:00:00.000Z');
    const [entry] = await database.database
      .insert(moodEntries)
      .values({
        id: randomUUID(),
        userId: auth.userId,
        clientRequestId: randomUUID(),
        moodScore: 2,
        emotion: null,
        note: null,
        stateRevision: 1,
        createdAt,
        updatedAt: createdAt,
      })
      .returning();
    const entriesRead = createDeferred();
    const allowTrendRead = createDeferred();
    moodRepository.setHistoryEntriesReadHook(async () => {
      moodRepository.setHistoryEntriesReadHook(null);
      entriesRead.resolve();
      await allowTrendRead.promise;
    });
    try {
      const history = withTimeout(
        moodService.list(auth.userId, { days: 7, limit: 20 }, new Date('2026-09-11T12:00:00Z')),
        'consistent Mood history read',
      );
      await withTimeout(entriesRead.promise, 'entries query barrier');
      await patchRequest(auth, `/mood-entries/${entry!.id}`)
        .send({ expectedRevision: 1, moodScore: 5, emotion: null, note: null })
        .expect(200);
      allowTrendRead.resolve();
      const first = moodHistoryResponseSchema.parse(await history);
      expect(first.data.entries[0]).toEqual(expect.objectContaining({ moodScore: 2 }));
      expect(first.data.dailyTrend).toEqual([
        { localDate: '2026-09-11', entryCount: 1, averageMoodScore: 2 },
      ]);
    } finally {
      allowTrendRead.resolve();
      moodRepository.setHistoryEntriesReadHook(null);
    }

    const refreshed = moodHistoryResponseSchema.parse(
      await moodService.list(auth.userId, { days: 7, limit: 20 }, new Date('2026-09-11T12:00:00Z')),
    );
    expect(refreshed.data.entries[0]).toEqual(
      expect.objectContaining({ moodScore: 5, stateRevision: 2 }),
    );
    expect(refreshed.data.dailyTrend).toEqual([
      { localDate: '2026-09-11', entryCount: 1, averageMoodScore: 5 },
    ]);
  });

  it('defines sequential delete-all ordering around a later committed create', async () => {
    const auth = await createAuthContext();
    const lateId = randomUUID();
    const lateClientRequestId = randomUUID();
    const creator = await migrationClient.pool.connect();
    try {
      await creator.query('BEGIN');
      const deleteBeforeCommit = await deleteRequest(auth, '/mood-entries').expect(200);
      expect(deleteBeforeCommit.body.data.entryCount).toBe(0);

      const timestamp = new Date();
      await creator.query(
        `INSERT INTO mood_entries
         (id, user_id, client_request_id, mood_score, emotion, note,
          state_revision, created_at, updated_at)
         VALUES ($1, $2, $3, 3, NULL, NULL, 1, $4, $4)`,
        [lateId, auth.userId, lateClientRequestId, timestamp],
      );
      await creator.query('COMMIT');

      const lateStatus = await get(
        auth,
        `/mood-entries/creation-status/${lateClientRequestId}`,
      ).expect(200);
      expect(lateStatus.body.data).toEqual(
        expect.objectContaining({
          status: 'present',
          entry: expect.objectContaining({ id: lateId }),
        }),
      );

      const visibleBeforeDelete = await post(auth, '/mood-entries')
        .send({ clientRequestId: randomUUID(), moodScore: 4 })
        .expect(201);
      const deleteAfterCommit = await deleteRequest(auth, '/mood-entries').expect(200);
      expect(deleteAfterCommit.body.data.entryCount).toBe(2);
      await get(auth, `/mood-entries/${visibleBeforeDelete.body.data.entry.id}`).expect(404);
    } finally {
      try {
        await creator.query('ROLLBACK');
      } finally {
        creator.release();
      }
    }
  });

  it('does not create RiskEvent or invoke AI side effects for Mood operations', async () => {
    const auth = await createAuthContext();
    const before = await database.database.select({ value: count() }).from(riskEvents);
    await post(auth, '/mood-entries')
      .send({
        clientRequestId: randomUUID(),
        moodScore: 1,
        emotion: 'overwhelmed',
        note: 'synthetic high-distress phrase for storage-boundary testing',
      })
      .expect(201);
    const after = await database.database.select({ value: count() }).from(riskEvents);
    expect(after[0]?.value).toBe(before[0]?.value);
  });
});
