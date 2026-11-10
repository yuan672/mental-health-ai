import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  createDatabaseClient,
  migrate,
  users,
  sessions,
  ageVerifications,
  passwordCredentials,
  diaryNotebooks,
  diaryPages,
  diaryPhotos,
  personalSettings,
  eq,
} from '@mental-health/database';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import sharp from 'sharp';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/database/database.service';
import { hashSessionToken } from '../src/auth/sessions.service';
import { AppExceptionFilter } from '../src/common/filters/app-exception.filter';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);
const content = {
  title: 'Synthetic diary',
  body: 'Synthetic diary body, no personal information.',
  mood: 'happy',
  weather: 'sun',
  photoIds: [],
};
type Auth = { userId: string; cookie: string; csrf: string };
describe('Account-owned diaries, photos and personal settings', () => {
  let app: INestApplication, db: DatabaseService, client: ReturnType<typeof createDatabaseClient>;
  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url || !new URL(url).pathname.endsWith('_test'))
      throw new Error('Dedicated _test database required');
    client = createDatabaseClient(url);
    // Migrate the isolated database without resetting any existing schema or account.
    await migrate(client.database, {
      migrationsFolder: resolve(process.cwd(), '../../database/migrations'),
    });
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.useLogger(false);
    app.useGlobalFilters(new AppExceptionFilter());
    await app.init();
    db = module.get(DatabaseService);
  }, 60000);
  afterAll(async () => {
    if (app) await app.close();
    if (client) await client.pool.end();
  });
  async function auth(): Promise<Auth> {
    const userId = randomUUID(),
      token = randomBytes(32).toString('base64url'),
      csrf = randomBytes(32).toString('base64url');
    await db.database.insert(users).values({ id: userId });
    await db.database
      .insert(passwordCredentials)
      .values({ userId, email: `diary-${userId}@example.test`, passwordHash: 'synthetic' });
    await db.database.insert(ageVerifications).values({
      userId,
      ageVerified: true,
      verificationMethod: 'synthetic',
      verifiedAt: new Date(),
    });
    await db.database.insert(sessions).values({
      id: randomUUID(),
      userId,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() + 86400000),
    });
    return { userId, cookie: `mh_session=${token}; mh_csrf=${csrf}`, csrf };
  }
  const req = (who: Auth, method: 'get' | 'post' | 'patch' | 'delete', path: string) => {
    const agent = request(app.getHttpServer());
    return agent[method](path)
      .set('Cookie', who.cookie)
      .set('Origin', 'http://localhost:5173')
      .set('x-csrf-token', who.csrf);
  };
  async function book(who: Auth) {
    const id = randomUUID();
    const result = await req(who, 'post', '/diary/notebooks')
      .send({ id, name: 'Synthetic notebook', cat: 'relaxed' })
      .expect(201);
    expect(result.body.data.book.id).toBe(id);
    return id;
  }
  it('requires authentication and CSRF and never exposes another account’s notebooks or photos', async () => {
    const a = await auth(),
      b = await auth(),
      id = await book(a),
      photoId = randomUUID();
    await request(app.getHttpServer()).get('/diary/notebooks').expect(401);
    await request(app.getHttpServer())
      .post('/diary/notebooks')
      .set('Cookie', a.cookie)
      .send({ id: randomUUID(), name: 'missing csrf', cat: 'happy' })
      .expect(403);
    await req(a, 'post', `/diary/notebooks/${id}/entries/2026-09-01/photos`)
      .field('photoId', photoId)
      .attach('image', png, { filename: 'synthetic.png', contentType: 'image/png' })
      .expect(201);
    expect((await req(b, 'get', '/diary/notebooks').expect(200)).body.data.books).toEqual([]);
    for (const path of [
      `/diary/notebooks/${id}`,
      `/diary/notebooks/${id}/entries/2026-09-01`,
      `/diary/notebooks/${id}/photos/${photoId}`,
    ])
      await req(b, 'get', path).expect(404);
    await req(b, 'patch', `/diary/notebooks/${id}`)
      .send({ name: 'other', cat: 'sad', expectedRevision: 1 })
      .expect(404);
    await req(b, 'delete', `/diary/notebooks/${id}`).send({ expectedRevision: 1 }).expect(404);
    const photo = await req(a, 'get', `/diary/notebooks/${id}/photos/${photoId}`)
      .expect(200)
      .expect('Content-Type', /image\/png/)
      .expect('Cache-Control', /no-store/)
      .expect('X-Content-Type-Options', 'nosniff');
    expect(Buffer.isBuffer(photo.body)).toBe(true);
    expect(photo.body.equals(png)).toBe(true);
  });
  it('keeps published content intact while drafting and rejects stale or invalid writes', async () => {
    const a = await auth(),
      id = await book(a),
      path = `/diary/notebooks/${id}/entries/2026-09-02`;
    expect((await req(a, 'get', path)).body.data.page.revision).toBe(0);
    await req(a, 'post', path).send({ expectedRevision: 0, content, publish: true }).expect(200);
    const draft = { ...content, body: 'A separate synthetic draft' };
    const r = await req(a, 'post', path)
      .send({ expectedRevision: 1, content: draft, publish: false })
      .expect(200);
    expect(r.body.data.page).toMatchObject({ revision: 2, saved: content, draft });
    await req(a, 'post', path)
      .send({ expectedRevision: 1, content: { ...content, body: 'stale' }, publish: true })
      .expect(409);
    const reread = await req(a, 'get', path).expect(200);
    expect(reread.body.data.page.saved).toEqual(content);
    expect(reread.body.data.page.draft).toEqual(draft);
    await req(a, 'post', path)
      .send({ expectedRevision: 2, content: { ...content, mood: null }, publish: true })
      .expect(400);
    await req(a, 'post', path)
      .send({
        expectedRevision: 2,
        content: { ...content, body: '猫'.repeat(10001) },
        publish: false,
      })
      .expect(400);
    await req(a, 'get', `/diary/notebooks/${id}/entries/2999-01-01`).expect(400);
    await req(a, 'get', `/diary/notebooks/${id}/entries/2026-02-30`).expect(400);
    const published = await req(a, 'post', path)
      .send({ expectedRevision: 2, content: draft, publish: true })
      .expect(200);
    expect(published.body.data.page.draft).toBeNull();
    expect(published.body.data.page.saved).toEqual(draft);
  });
  it('uploads idempotently, bounds and verifies photos, and deletes unreferenced photos', async () => {
    const a = await auth(),
      id = await book(a),
      path = `/diary/notebooks/${id}/entries/2026-09-03`,
      photoId = randomUUID();
    for (let i = 0; i < 2; i++)
      await req(a, 'post', `${path}/photos`)
        .field('photoId', photoId)
        .attach('image', png, { filename: 'synthetic.png', contentType: 'image/png' })
        .expect(201);
    expect((await req(a, 'get', path)).body.data.page.photos).toHaveLength(1);
    await req(a, 'post', `${path}/photos`)
      .field('photoId', randomUUID())
      .attach('image', Buffer.from('<svg onload="alert(1)"></svg>'), {
        filename: 'not-an-image.png',
        contentType: 'image/png',
      })
      .expect(400);
    await req(a, 'post', `${path}/photos`)
      .field('photoId', randomUUID())
      .attach('image', Buffer.alloc(10 * 1024 * 1024 + 1), {
        filename: 'huge.png',
        contentType: 'image/png',
      })
      .expect(413);
    await req(a, 'post', path)
      .send({
        expectedRevision: 0,
        content: { ...content, photoIds: [randomUUID()] },
        publish: true,
      })
      .expect(400);
    await req(a, 'post', path)
      .send({
        expectedRevision: 0,
        content: { ...content, body: '', photoIds: [photoId] },
        publish: true,
      })
      .expect(200);
    await req(a, 'delete', `/diary/notebooks/${id}/photos/${photoId}`).expect(409);
    await req(a, 'post', path).send({ expectedRevision: 1, content, publish: true }).expect(200);
    await req(a, 'delete', `/diary/notebooks/${id}/photos/${photoId}`).expect(200);
    await req(a, 'get', `/diary/notebooks/${id}/photos/${photoId}`).expect(404);
  });
  it('separates notebooks, preserves settings ownership, and cascades account deletion', async () => {
    const a = await auth(),
      b = await auth(),
      first = await book(a),
      second = await book(a),
      day = '2026-09-04';
    await req(a, 'post', `/diary/notebooks/${first}/entries/${day}`)
      .send({ expectedRevision: 0, content, publish: true })
      .expect(200);
    expect(
      (await req(a, 'get', `/diary/notebooks/${second}/entries/${day}`)).body.data.page.saved,
    ).toBeNull();
    const settings = {
      displayName: '小橘',
      cat: 'happy',
      readingSize: 20,
      bookmarks: ['synthetic-article'],
    };
    const saved = await req(a, 'patch', '/profile/settings')
      .send({ ...settings, expectedRevision: 0 })
      .expect(200);
    expect(saved.body.data.settings).toEqual({
      ...settings,
      biography: '',
      avatarId: null,
      revision: 1,
    });
    await req(a, 'patch', '/profile/settings')
      .send({ ...settings, expectedRevision: 0 })
      .expect(409);
    expect((await req(b, 'get', '/profile/settings')).body.data.settings.displayName).toBe('');
    await req(a, 'patch', '/profile/settings')
      .send({ ...settings, expectedRevision: 1, userId: b.userId })
      .expect(400);
    const photoId = randomUUID();
    await req(a, 'post', `/diary/notebooks/${first}/entries/${day}/photos`)
      .field('photoId', photoId)
      .attach('image', png, { filename: 'synthetic.png' })
      .expect(201);
    await db.database.delete(users).where(eq(users.id, a.userId));
    expect(
      await db.database.select().from(diaryNotebooks).where(eq(diaryNotebooks.userId, a.userId)),
    ).toEqual([]);
    expect(
      await db.database.select().from(diaryPages).where(eq(diaryPages.notebookId, first)),
    ).toEqual([]);
    expect(await db.database.select().from(diaryPhotos).where(eq(diaryPhotos.id, photoId))).toEqual(
      [],
    );
    expect(
      await db.database
        .select()
        .from(personalSettings)
        .where(eq(personalSettings.userId, a.userId)),
    ).toEqual([]);
  });
  it('paginates past entries and rejects deleting a stale page or notebook revision', async () => {
    const a = await auth(),
      id = await book(a);
    await req(a, 'patch', `/diary/notebooks/${id}`)
      .send({ name: 'Renamed synthetic', cat: 'hopeful', expectedRevision: 1 })
      .expect(200);
    await req(a, 'delete', `/diary/notebooks/${id}`).send({ expectedRevision: 1 }).expect(409);
    const rows = Array.from({ length: 32 }, (_, index) => ({
      notebookId: id,
      day: new Date(Date.UTC(2026, 6, index + 1)).toISOString().slice(0, 10),
      saved: content,
      revision: 1,
    }));
    await db.database.insert(diaryPages).values(rows);
    const first = await req(a, 'get', `/diary/notebooks/${id}`).expect(200);
    expect(first.body.data.entries).toHaveLength(30);
    expect(first.body.data.entries[0]).not.toHaveProperty('body');
    const second = await req(
      a,
      'get',
      `/diary/notebooks/${id}?before=${first.body.data.nextBefore}`,
    ).expect(200);
    expect(second.body.data.entries).toHaveLength(2);
    expect(second.body.data.nextBefore).toBeNull();
    await req(a, 'delete', `/diary/notebooks/${id}/entries/2026-07-01`)
      .send({ expectedRevision: 0 })
      .expect(409);
    await req(a, 'delete', `/diary/notebooks/${id}/entries/2026-07-01`)
      .send({ expectedRevision: 1 })
      .expect(200);
    await req(a, 'delete', `/diary/notebooks/${id}`).send({ expectedRevision: 2 }).expect(200);
    expect(
      await db.database.select().from(diaryPages).where(eq(diaryPages.notebookId, id)),
    ).toEqual([]);
  });
  it('saves avatar/name/biography atomically, protects image reads and retains fields for older clients', async () => {
    const a = await auth(),
      b = await auth();
    const image = await sharp({
      create: { width: 700, height: 500, channels: 3, background: '#d0dfbd' },
    })
      .png()
      .toBuffer();
    const fields = {
      displayName: '合成头像用户',
      biography: '喜欢散步与小猫。',
      cat: 'shy',
      readingSize: 20,
      bookmarks: [],
    };
    const upload = () =>
      req(a, 'post', '/profile/settings')
        .field('settings', JSON.stringify({ ...fields, expectedRevision: 0, avatarId: null }))
        .attach('image', image, { filename: 'synthetic.png', contentType: 'image/png' });
    const saved = (await upload().expect(200)).body.data.settings;
    expect(saved).toMatchObject({ ...fields, revision: 1, avatarId: expect.any(String) });
    expect(saved).not.toHaveProperty('avatarData');
    const url = '/profile/settings/avatar/' + saved.avatarId;
    await request(app.getHttpServer()).get(url).expect(401);
    await req(b, 'get', url).expect(404);
    const picture = await req(a, 'get', url)
      .expect(200)
      .expect('Content-Type', /image\/webp/)
      .expect('Cache-Control', /no-store/)
      .expect('X-Content-Type-Options', 'nosniff');
    expect(await sharp(picture.body).metadata()).toMatchObject({ format: 'webp', width: 512 });
    await upload().expect(409);
    expect((await req(a, 'get', '/profile/settings')).body.data.settings).toEqual(saved);
    // An older reading-preferences client must not erase the biography or avatar.
    const legacy = {
      displayName: fields.displayName,
      cat: fields.cat,
      readingSize: 18,
      bookmarks: ['synthetic'],
      expectedRevision: 1,
    };
    expect(
      (await req(a, 'patch', '/profile/settings').send(legacy).expect(200)).body.data.settings,
    ).toMatchObject({ biography: fields.biography, avatarId: saved.avatarId, revision: 2 });
    await req(b, 'patch', '/profile/settings')
      .send({ ...legacy, expectedRevision: 0, avatarId: saved.avatarId })
      .expect(404);
    await req(a, 'patch', '/profile/settings')
      .send({ ...legacy, expectedRevision: 2, avatarId: null, cat: 'happy', biography: '' })
      .expect(200);
    await req(a, 'get', url).expect(404);
    const cleared = (await req(a, 'get', '/profile/settings')).body.data.settings;
    expect(cleared).toMatchObject({ avatarId: null, biography: '', cat: 'happy', revision: 3 });
    expect(
      (
        await db.database
          .select()
          .from(personalSettings)
          .where(eq(personalSettings.userId, a.userId))
      )[0]?.avatarData,
    ).toBeNull();
  });
  it('rejects invalid avatar uploads, long biographies and missing CSRF without altering settings', async () => {
    const a = await auth();
    const fields = {
      displayName: '合成',
      cat: 'happy',
      readingSize: 18,
      bookmarks: [],
      expectedRevision: 0,
    };
    await req(a, 'patch', '/profile/settings')
      .send({ ...fields, biography: '🐱'.repeat(201) })
      .expect(400);
    for (const bytes of [
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      Buffer.concat([png.subarray(0, 12), Buffer.from('broken')]),
    ]) {
      await req(a, 'post', '/profile/settings')
        .field('settings', JSON.stringify(fields))
        .attach('image', bytes, 'fake.png')
        .expect(400);
    }
    await req(a, 'post', '/profile/settings')
      .field('settings', '{bad json}')
      .attach('image', png, 'fake.png')
      .expect(400);
    await req(a, 'post', '/profile/settings').field('settings', JSON.stringify(fields)).expect(400);
    await req(a, 'post', '/profile/settings')
      .field('settings', JSON.stringify(fields))
      .attach('image', Buffer.alloc(5 * 1024 * 1024 + 1), 'large.png')
      .expect(413);
    await request(app.getHttpServer())
      .post('/profile/settings')
      .set('Cookie', a.cookie)
      .field('settings', JSON.stringify(fields))
      .attach('image', png, 'synthetic.png')
      .expect(403);
    expect((await req(a, 'get', '/profile/settings')).body.data.settings).toMatchObject({
      revision: 0,
      avatarId: null,
      biography: '',
    });
  });
  it('replaces only the owned avatar and cascades it with account deletion', async () => {
    const a = await auth();
    const image = await sharp({
      create: { width: 20, height: 20, channels: 3, background: '#cdddcc' },
    })
      .png()
      .toBuffer();
    const fields = { displayName: '合成', cat: 'happy', readingSize: 18, bookmarks: [] };
    const upload = (revision: number) =>
      req(a, 'post', '/profile/settings')
        .field('settings', JSON.stringify({ ...fields, expectedRevision: revision }))
        .attach('image', image, 'image.png');
    const first = (await upload(0).expect(200)).body.data.settings;
    const second = (await upload(1).expect(200)).body.data.settings;
    expect(second.avatarId).not.toBe(first.avatarId);
    await req(a, 'get', '/profile/settings/avatar/' + first.avatarId).expect(404);
    await req(a, 'get', '/profile/settings/avatar/' + second.avatarId).expect(200);
    await db.database.delete(users).where(eq(users.id, a.userId));
    expect(
      await db.database
        .select()
        .from(personalSettings)
        .where(eq(personalSettings.userId, a.userId)),
    ).toEqual([]);
  });
});
