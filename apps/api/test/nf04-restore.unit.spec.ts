import type { Pool, QueryResult } from '@mental-health/database';
import type {
  Nf04ProcessResult,
  Nf04ProcessRunner,
  Nf04ProcessSpec,
  Nf04RunningProcess,
} from '../src/nf04/nf04-process';
import {
  Nf04RestoreCoordinator,
  PostgresNf04RestoreBackendMonitor,
  type Nf04RestoreBackendIdentity,
  type Nf04RestoreBackendMonitor,
} from '../src/nf04/nf04-restore';

const BACKEND: Nf04RestoreBackendIdentity = {
  pid: 4123,
  backendStart: '2026-09-13T04:00:00.000Z',
  databaseName: 'mh_nf04_a1b2c3d4_pre_restore_test',
  databaseOid: 20_001,
  roleName: 'mh_nf04_a1b2c3d4_restore_role',
  roleOid: 20_002,
  applicationName: 'mh-nf04-20260913-143000-a1b2c3d4-restore-pre',
  clientAddress: null,
};

class RestoreRunner implements Nf04ProcessRunner {
  readonly calls: Nf04ProcessSpec[] = [];
  stopCount = 0;

  constructor(
    private readonly processResult: Nf04ProcessResult,
    private readonly afterStart?: () => void,
  ) {}

  run(): Promise<Nf04ProcessResult> {
    throw new Error('not used');
  }

  start(spec: Nf04ProcessSpec): Nf04RunningProcess {
    this.calls.push(spec);
    this.afterStart?.();
    return {
      localPid: 7321,
      startedAt: new Date('2026-09-13T04:00:00.000Z'),
      result: Promise.resolve(this.processResult),
      stop: () => {
        this.stopCount += 1;
      },
    };
  }
}

class RestoreMonitor implements Nf04RestoreBackendMonitor {
  readonly cancelled: Nf04RestoreBackendIdentity[] = [];
  readonly terminated: Nf04RestoreBackendIdentity[] = [];
  private reads = 0;

  constructor(
    private readonly results: readonly (readonly Nf04RestoreBackendIdentity[])[],
    private readonly absentAfterCancel = true,
    private readonly absentAfterTerminate = true,
  ) {}

  async findMatches(): Promise<readonly Nf04RestoreBackendIdentity[]> {
    const result = this.results[Math.min(this.reads, this.results.length - 1)] ?? [];
    this.reads += 1;
    return result;
  }

  async cancel(identity: Nf04RestoreBackendIdentity): Promise<boolean> {
    this.cancelled.push(identity);
    return true;
  }

  async terminate(identity: Nf04RestoreBackendIdentity): Promise<boolean> {
    this.terminated.push(identity);
    return true;
  }

  async waitUntilAbsent(): Promise<boolean> {
    return this.terminated.length > 0 ? this.absentAfterTerminate : this.absentAfterCancel;
  }
}

const INPUT = {
  restoreContainerId: 'exact-restore-container-id',
  restoreRole: BACKEND.roleName,
  restoreRoleOid: BACKEND.roleOid,
  targetDatabase: BACKEND.databaseName,
  targetDatabaseOid: BACKEND.databaseOid,
  applicationName: BACKEND.applicationName,
  archiveFileName: 'pre-delete.dump' as const,
  pgPassContainerPath: '/run/secrets/restore.pgpass',
  timeoutMs: 180_000,
  reconciliationTimeoutMs: 10_000,
};

describe('NF-04 restore writer coordination', () => {
  it('accepts success only when the structured command succeeds and no writer remains', async () => {
    const runner = new RestoreRunner({
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
    const monitor = new RestoreMonitor([[], []]);
    await expect(new Nf04RestoreCoordinator(runner, monitor).restore(INPUT)).resolves.toEqual({
      status: 'completed',
      localPid: 7321,
    });
    expect(runner.calls[0]?.args).toEqual(
      expect.arrayContaining([
        'pg_restore',
        '--single-transaction',
        '--exit-on-error',
        '--no-owner',
        '--no-privileges',
      ]),
    );
  });

  it('stops the local launcher and settles the exact backend without calling it success', async () => {
    const runner = new RestoreRunner({
      exitCode: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
      timedOut: true,
    });
    const monitor = new RestoreMonitor([[], [BACKEND]], true);
    await expect(new Nf04RestoreCoordinator(runner, monitor).restore(INPUT)).resolves.toEqual({
      status: 'settled_unknown',
      localPid: 7321,
      backend: BACKEND,
    });
    expect(runner.stopCount).toBe(1);
    expect(monitor.cancelled).toEqual([BACKEND]);
    expect(monitor.terminated).toEqual([]);
  });

  it('terminates only the still-matching exact backend and proves absence independently', async () => {
    const runner = new RestoreRunner({
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
    const monitor = new RestoreMonitor([[], [BACKEND]], false, true);
    const result = await new Nf04RestoreCoordinator(runner, monitor).restore(INPUT);
    expect(result.status).toBe('settled_unknown');
    expect(monitor.cancelled).toEqual([BACKEND]);
    expect(monitor.terminated).toEqual([BACKEND]);
  });

  it('continues bounded writer reconciliation after caller cancellation', async () => {
    const controller = new AbortController();
    const runner = new RestoreRunner(
      { exitCode: null, signal: 'SIGTERM', stdout: '', stderr: '', timedOut: false },
      () => controller.abort(),
    );
    const monitor = new RestoreMonitor([[], [BACKEND]], true);
    await expect(
      new Nf04RestoreCoordinator(runner, monitor).restore({
        ...INPUT,
        signal: controller.signal,
      }),
    ).resolves.toEqual({
      status: 'settled_unknown',
      localPid: 7321,
      backend: BACKEND,
    });
    expect(monitor.cancelled).toEqual([BACKEND]);
  });

  it('quarantines multiple or changed backend identities without signaling them', async () => {
    const runner = new RestoreRunner({
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
    const second = { ...BACKEND, pid: 4124, backendStart: '2026-09-13T04:00:01.000Z' };
    const monitor = new RestoreMonitor([[], [BACKEND, second]]);
    await expect(new Nf04RestoreCoordinator(runner, monitor).restore(INPUT)).resolves.toEqual(
      expect.objectContaining({ status: 'quarantined' }),
    );
    expect(monitor.cancelled).toHaveLength(0);
    expect(monitor.terminated).toHaveLength(0);
  });
});

describe('PostgreSQL NF-04 restore backend monitor', () => {
  const managerIdentity = {
    databaseName: 'mh_nf04_a1b2c3d4_restore_test',
    databaseOid: 19_001,
    systemIdentifier: '7612345678901234567',
    roleName: 'nf04_initialization_manager',
  };

  function fakePool(activityRows: Array<Record<string, unknown>[]>, signaled = true): Pool {
    return {
      query: jest.fn(async (text: string, values?: unknown[]) => {
        if (text.includes('current_database()')) {
          return result([
            {
              database_name: managerIdentity.databaseName,
              database_oid: managerIdentity.databaseOid,
              system_identifier: managerIdentity.systemIdentifier,
              current_user_name: managerIdentity.roleName,
            },
          ]);
        }
        if (text.includes('pg_cancel_backend') || text.includes('pg_terminate_backend')) {
          expect(text).toContain('a.backend_start=$2');
          expect(text).toContain('a.client_addr IS NOT DISTINCT FROM $9::inet');
          expect(values).toEqual([
            BACKEND.pid,
            new Date(BACKEND.backendStart),
            BACKEND.databaseOid,
            BACKEND.databaseName,
            BACKEND.roleOid,
            BACKEND.roleName,
            BACKEND.applicationName,
            expect.any(Number),
            BACKEND.clientAddress,
          ]);
          return result(signaled ? [{ signaled: true }] : []);
        }
        if (text.includes('FROM pg_stat_activity')) {
          expect(text).not.toMatch(/\ba\.query\b|\bquery\s+AS\b/i);
          return result(activityRows.shift() ?? []);
        }
        throw new Error('unexpected query');
      }),
    } as unknown as Pool;
  }

  it('reads no query text and signals only the exact recorded backend identity', async () => {
    const pool = fakePool([[databaseRow(BACKEND)]]);
    const monitor = new PostgresNf04RestoreBackendMonitor(pool, managerIdentity);
    await expect(
      monitor.findMatches({
        databaseName: BACKEND.databaseName,
        databaseOid: BACKEND.databaseOid,
        roleName: BACKEND.roleName,
        roleOid: BACKEND.roleOid,
        applicationName: BACKEND.applicationName,
      }),
    ).resolves.toEqual([BACKEND]);
    await expect(monitor.cancel(BACKEND)).resolves.toBe(true);
    await expect(monitor.terminate(BACKEND, 1_000)).resolves.toBe(true);
  });

  it('treats a reused PID with a different backend_start as absence of the original writer', async () => {
    let clock = 0;
    const reused = {
      ...BACKEND,
      backendStart: '2026-09-13T04:05:00.000Z',
    };
    const pool = fakePool([[databaseRow(reused)]]);
    const monitor = new PostgresNf04RestoreBackendMonitor(
      pool,
      managerIdentity,
      100,
      1,
      () => clock,
      async (milliseconds) => {
        clock += milliseconds;
      },
    );
    await expect(monitor.waitUntilAbsent(BACKEND)).resolves.toBe(true);
  });

  it('fails closed before activity inspection when the control database identity changes', async () => {
    const pool = {
      query: jest.fn(async () =>
        result([
          {
            database_name: managerIdentity.databaseName,
            database_oid: managerIdentity.databaseOid,
            system_identifier: 'different-system',
            current_user_name: managerIdentity.roleName,
          },
        ]),
      ),
    } as unknown as Pool;
    const monitor = new PostgresNf04RestoreBackendMonitor(pool, managerIdentity);
    await expect(
      monitor.findMatches({
        databaseName: BACKEND.databaseName,
        databaseOid: BACKEND.databaseOid,
        roleName: BACKEND.roleName,
        roleOid: BACKEND.roleOid,
        applicationName: BACKEND.applicationName,
      }),
    ).rejects.toThrow(/system identifier/i);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

function databaseRow(identity: Nf04RestoreBackendIdentity): Record<string, unknown> {
  return {
    pid: identity.pid,
    backend_start: identity.backendStart,
    database_name: identity.databaseName,
    database_oid: identity.databaseOid,
    role_name: identity.roleName,
    role_oid: identity.roleOid,
    application_name: identity.applicationName,
    client_address: identity.clientAddress,
  };
}

function result(rows: Record<string, unknown>[]): QueryResult<never> {
  return { rows, command: 'SELECT', rowCount: rows.length, oid: 0, fields: [] } as never;
}
