import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDatabaseClient, migrate } from '@mental-health/database';

type Journal = {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
};

describe('migration 0009 Admin identity foundation', () => {
  let client: ReturnType<typeof createDatabaseClient>;
  let temporaryRoot: string;
  let through0008: string;
  let through0009: string;

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('TEST_DATABASE_URL is required');
    const name = decodeURIComponent(new URL(url).pathname.slice(1));
    if (!name.endsWith('_test')) throw new Error('Refusing non-test database');
    client = createDatabaseClient(url);
    temporaryRoot = await mkdtemp(join(tmpdir(), 'mental-health-ai-migration-0009-'));
    through0008 = join(temporaryRoot, 'through-0008');
    through0009 = join(temporaryRoot, 'through-0009');
    await materialize(through0008, 8);
    await materialize(through0009, 9);
  });

  beforeEach(async () => {
    await reset();
    await migrate(client.database, { migrationsFolder: through0008 });
  });

  afterAll(async () => {
    await client.pool.end();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  async function reset(): Promise<void> {
    await client.pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await client.pool.query('DROP SCHEMA public CASCADE');
    await client.pool.query('CREATE SCHEMA public');
  }

  async function materialize(target: string, maximum: number): Promise<void> {
    const source = resolve(process.cwd(), '../../database/migrations');
    const journal = JSON.parse(
      await readFile(join(source, 'meta', '_journal.json'), 'utf8'),
    ) as Journal;
    const entries = journal.entries.filter((entry) => entry.idx <= maximum);
    await mkdir(join(target, 'meta'), { recursive: true });
    for (const entry of entries) {
      await copyFile(join(source, `${entry.tag}.sql`), join(target, `${entry.tag}.sql`));
    }
    await writeFile(join(target, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
  }

  it('applies all migrations to an empty protected database', async () => {
    await reset();
    await migrate(client.database, { migrationsFolder: through0009 });
    const tables = await client.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_name LIKE 'staff_%' ORDER BY table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'staff_password_credentials',
      'staff_principals',
      'staff_role_grants',
      'staff_sessions',
    ]);
  });

  it('upgrades a non-empty 0008 database without changing existing data', async () => {
    const userId = randomUUID();
    await client.pool.query('INSERT INTO users (id) VALUES ($1)', [userId]);
    await migrate(client.database, { migrationsFolder: through0009 });
    const users = await client.pool.query<{ id: string }>(
      'SELECT id::text FROM users WHERE id=$1',
      [userId],
    );
    expect(users.rows).toEqual([{ id: userId }]);
    const staff = await client.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM staff_principals',
    );
    expect(staff.rows[0]?.count).toBe(0);
  });

  it('enforces retained bootstrap uniqueness and immutable role evidence', async () => {
    await migrate(client.database, { migrationsFolder: through0009 });
    const first = randomUUID();
    const second = randomUUID();
    for (const id of [first, second]) {
      await client.pool.query('INSERT INTO staff_principals (id) VALUES ($1)', [id]);
      await client.pool.query(
        `INSERT INTO staff_password_credentials (staff_principal_id,email,password_hash)
         VALUES ($1,$2,'synthetic-hash')`,
        [id, `${id}@example.test`],
      );
    }
    const grantId = randomUUID();
    await client.pool.query(
      `INSERT INTO staff_role_grants
       (id,staff_principal_id,role_key,grant_source,granted_by_principal_id)
       VALUES ($1,$2,'access_administrator','bootstrap',NULL)`,
      [grantId, first],
    );
    await expect(
      client.pool.query(
        `INSERT INTO staff_role_grants
         (id,staff_principal_id,role_key,grant_source,granted_by_principal_id)
         VALUES ($1,$2,'access_administrator','bootstrap',NULL)`,
        [randomUUID(), second],
      ),
    ).rejects.toBeDefined();
    await expect(
      client.pool.query('UPDATE staff_role_grants SET role_key=$1 WHERE id=$2', [
        'audit_reader',
        grantId,
      ]),
    ).rejects.toBeDefined();
    await client.pool.query(
      'UPDATE staff_role_grants SET revoked_at=now(),revoked_by_principal_id=$1 WHERE id=$2',
      [second, grantId],
    );
    await expect(
      client.pool.query('UPDATE staff_role_grants SET revoked_at=NULL WHERE id=$1', [grantId]),
    ).rejects.toBeDefined();

    const delegatedGrant = randomUUID();
    await client.pool.query(
      `INSERT INTO staff_role_grants
       (id,staff_principal_id,role_key,grant_source,granted_by_principal_id)
       VALUES ($1,$2,'audit_reader','staff',$3)`,
      [delegatedGrant, first, second],
    );
    await client.pool.query('DELETE FROM staff_principals WHERE id=$1', [second]);
    const preserved = await client.pool.query<{
      staff_principal_id: string;
      granted_by_principal_id: string | null;
    }>(
      `SELECT staff_principal_id::text,granted_by_principal_id::text
       FROM staff_role_grants WHERE id=$1`,
      [delegatedGrant],
    );
    expect(preserved.rows).toEqual([{ staff_principal_id: first, granted_by_principal_id: null }]);
  });

  it('fails atomically when the target structure conflicts and does not record 0009', async () => {
    const userId = randomUUID();
    await client.pool.query('INSERT INTO users (id) VALUES ($1)', [userId]);
    await client.pool.query('CREATE TABLE staff_principals (placeholder integer NOT NULL)');
    await expect(migrate(client.database, { migrationsFolder: through0009 })).rejects.toBeDefined();
    const staffColumns = await client.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='staff_principals'`,
    );
    expect(staffColumns.rows).toEqual([{ column_name: 'placeholder' }]);
    const history = await client.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations',
    );
    expect(history.rows[0]?.count).toBe(9);
    const users = await client.pool.query<{ id: string }>(
      'SELECT id::text FROM users WHERE id=$1',
      [userId],
    );
    expect(users.rows).toEqual([{ id: userId }]);
  });
});
