import type { Pool, PoolClient, QueryResult } from '@mental-health/database';
import {
  Nf04RestoreCoordinator,
  PostgresNf04RestoreBackendMonitor,
  type Nf04ContainerExecExit,
  type Nf04ContainerExecSpec,
  type Nf04ContainerExecution,
  type Nf04ContainerExecutionPort,
  type Nf04LifecycleClock,
  type Nf04RestoreBackendIdentity,
  type Nf04RestoreBackendMonitor,
} from '../src/nf04/nf04-restore';

const BACKEND: Nf04RestoreBackendIdentity = {
  pid: 4123,
  backendStart: '2026-09-13T04:00:00.123456Z',
  databaseName: 'mh_nf04_a1b2c3d4_pre_restore_test',
  databaseOid: 20_001,
  roleName: 'mh_nf04_a1b2c3d4_restore_role',
  roleOid: 20_002,
  applicationName: 'mh-nf04-20260913-143000-a1b2c3d4-restore-pre',
  clientAddress: null,
};

class RestoreExecution implements Nf04ContainerExecution {
  readonly identity = {
    containerId: 'exact-restore-container-id',
    execId: 'd8f72f-exact-container-exec-id',
  };
  readonly localPid = 7321;
  startCount = 0;
  stopCount = 0;
  waitCount = 0;

  constructor(
    private readonly exits: Array<() => Promise<Nf04ContainerExecExit>>,
    private readonly onStart?: () => void,
    private readonly stopResult: () => Promise<void> = async () => undefined,
  ) {}

  async start(): Promise<void> {
    this.startCount += 1;
    this.onStart?.();
  }

  stop(): Promise<void> {
    this.stopCount += 1;
    return this.stopResult();
  }

  waitForExit(): Promise<Nf04ContainerExecExit> {
    this.waitCount += 1;
    return this.exits.shift()?.() ?? Promise.reject(new Error('missing exact-exec result'));
  }
}

class RestoreExecutionPort implements Nf04ContainerExecutionPort {
  readonly calls: Nf04ContainerExecSpec[] = [];

  constructor(private readonly execution: Nf04ContainerExecution) {}

  async create(spec: Nf04ContainerExecSpec): Promise<Nf04ContainerExecution> {
    this.calls.push(spec);
    return this.execution;
  }
}

class StartRaceExecution implements Nf04ContainerExecution {
  readonly identity = {
    containerId: 'exact-restore-container-id',
    execId: 'late-start-container-exec-id',
  };
  readonly localPid = 7331;
  readonly startAcknowledgement = deferred<void>();
  readonly exit = deferred<Nf04ContainerExecExit>();
  startCount = 0;
  stopCount = 0;
  waitCount = 0;
  stoppedAfterStart = false;

  start(): Promise<void> {
    this.startCount += 1;
    // Models a request already accepted by a container engine whose acknowledgement
    // is not cancelled when the caller's wait expires.
    return this.startAcknowledgement.promise;
  }

  async stop(signal?: AbortSignal): Promise<void> {
    this.stopCount += 1;
    await observeWithSignal(this.startAcknowledgement.promise, signal);
    this.stoppedAfterStart = true;
    this.exit.resolve({ exitCode: 137 });
  }

  waitForExit(signal?: AbortSignal): Promise<Nf04ContainerExecExit> {
    this.waitCount += 1;
    return observeWithSignal(this.exit.promise, signal);
  }
}

class RestoreMonitor implements Nf04RestoreBackendMonitor {
  readonly findCalls: Array<Parameters<Nf04RestoreBackendMonitor['findMatches']>[0]> = [];
  readonly cancelled: Nf04RestoreBackendIdentity[] = [];
  readonly cancelTimeouts: number[] = [];
  readonly terminated: Array<{ identity: Nf04RestoreBackendIdentity; timeoutMs: number }> = [];

  constructor(
    private readonly results: Array<
      readonly Nf04RestoreBackendIdentity[] | Promise<readonly Nf04RestoreBackendIdentity[]>
    >,
    private readonly absenceResults: Array<boolean | Promise<boolean>> = [],
    private readonly onCancel?: () => void,
  ) {}

  findMatches(
    input: Parameters<Nf04RestoreBackendMonitor['findMatches']>[0],
  ): Promise<readonly Nf04RestoreBackendIdentity[]> {
    this.findCalls.push(input);
    return Promise.resolve(this.results.shift() ?? []);
  }

  async cancel(
    identity: Nf04RestoreBackendIdentity,
    _signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<boolean> {
    this.cancelled.push(identity);
    if (timeoutMs !== undefined) this.cancelTimeouts.push(timeoutMs);
    this.onCancel?.();
    return true;
  }

  async terminate(identity: Nf04RestoreBackendIdentity, timeoutMs: number): Promise<boolean> {
    this.terminated.push({ identity, timeoutMs });
    return true;
  }

  waitUntilAbsent(): Promise<boolean> {
    return Promise.resolve(this.absenceResults.shift() ?? true);
  }
}

class ControlledClock implements Nf04LifecycleClock {
  private current = 0;
  private readonly timers = new Set<{
    due: number;
    callback: () => void;
    cancelled: boolean;
  }>();

  now(): number {
    return this.current;
  }

  schedule(callback: () => void, milliseconds: number): Readonly<{ cancel(): void }> {
    const timer = { due: this.current + milliseconds, callback, cancelled: false };
    this.timers.add(timer);
    return {
      cancel: () => {
        timer.cancelled = true;
        this.timers.delete(timer);
      },
    };
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
    for (const timer of [...this.timers]) {
      if (!timer.cancelled && timer.due <= this.current) {
        timer.cancelled = true;
        this.timers.delete(timer);
        timer.callback();
      }
    }
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
  it('accepts success only after exact container exec exit and a same-identity backend scan', async () => {
    const exactExit = deferred<Nf04ContainerExecExit>();
    const execution = new RestoreExecution([() => exactExit.promise]);
    const port = new RestoreExecutionPort(execution);
    const monitor = new RestoreMonitor([[], []]);
    const pending = new Nf04RestoreCoordinator(port, monitor).restore(INPUT);
    await flushMicrotasks();

    expect(execution.startCount).toBe(1);
    expect(monitor.findCalls).toHaveLength(1);

    exactExit.resolve({ exitCode: 0 });
    await expect(pending).resolves.toEqual({ status: 'completed', localPid: 7321 });
    expect(monitor.findCalls).toHaveLength(2);
    expect(port.calls[0]).toEqual({
      containerId: INPUT.restoreContainerId,
      executable: 'pg_restore',
      args: expect.arrayContaining([
        '--single-transaction',
        '--exit-on-error',
        '--no-owner',
        '--no-privileges',
      ]),
      environment: {
        PGPASSFILE: INPUT.pgPassContainerPath,
        PGAPPNAME: INPUT.applicationName,
      },
    });
  });

  it('stops and proves exact exec exit before accepting absence of a late backend', async () => {
    const execution = new RestoreExecution([
      () => Promise.reject(new Error('host-side wait failed')),
      async () => ({ exitCode: 137 }),
    ]);
    const monitor = new RestoreMonitor([[], [], []]);
    await expect(
      new Nf04RestoreCoordinator(new RestoreExecutionPort(execution), monitor).restore(INPUT),
    ).resolves.toEqual({ status: 'settled_unknown', localPid: 7321, backend: null });
    expect(execution.stopCount).toBe(1);
    expect(execution.waitCount).toBe(2);
    expect(monitor.findCalls).toHaveLength(3);
  });

  it('settles one exact backend then rejects a reused identity in the final full scan', async () => {
    const reused = { ...BACKEND, pid: 4124, backendStart: '2026-09-13T04:00:00.123457Z' };
    const execution = new RestoreExecution([async () => ({ exitCode: 1 })]);
    const monitor = new RestoreMonitor([[], [BACKEND], [reused]], [true]);
    await expect(
      new Nf04RestoreCoordinator(new RestoreExecutionPort(execution), monitor).restore(INPUT),
    ).resolves.toEqual(
      expect.objectContaining({ status: 'quarantined', reason: expect.stringMatching(/active/) }),
    );
    expect(monitor.cancelled).toEqual([BACKEND]);
    expect(monitor.terminated).toHaveLength(0);
  });

  it('escalates to termination and proves both exact and same-identity absence', async () => {
    const execution = new RestoreExecution([async () => ({ exitCode: 1 })]);
    const monitor = new RestoreMonitor([[], [BACKEND], []], [false, true]);
    await expect(
      new Nf04RestoreCoordinator(new RestoreExecutionPort(execution), monitor).restore(INPUT),
    ).resolves.toEqual({ status: 'settled_unknown', localPid: 7321, backend: BACKEND });
    expect(monitor.cancelled).toEqual([BACKEND]);
    expect(monitor.terminated).toHaveLength(1);
    expect(monitor.terminated[0]?.identity).toEqual(BACKEND);
    expect(monitor.terminated[0]?.timeoutMs).toBeGreaterThan(0);
    expect(monitor.terminated[0]?.timeoutMs).toBeLessThanOrEqual(10_000);
    expect(monitor.findCalls).toHaveLength(3);
  });

  it('continues exact-exec and backend reconciliation after caller cancellation', async () => {
    const controller = new AbortController();
    const execution = new RestoreExecution([async () => ({ exitCode: 137 })], () =>
      controller.abort(),
    );
    const monitor = new RestoreMonitor([[], [BACKEND], []], [true]);
    await expect(
      new Nf04RestoreCoordinator(new RestoreExecutionPort(execution), monitor).restore({
        ...INPUT,
        signal: controller.signal,
      }),
    ).resolves.toEqual({ status: 'settled_unknown', localPid: 7321, backend: BACKEND });
    expect(execution.stopCount).toBe(1);
    expect(monitor.cancelled).toEqual([BACKEND]);
    expect(monitor.findCalls.slice(1).every((call) => call.signal !== controller.signal)).toBe(
      true,
    );
  });

  it('uses one reconciliation deadline across stop, waits, signals and final checks', async () => {
    const clock = new ControlledClock();
    const neverAbsent = deferred<boolean>();
    const execution = new RestoreExecution([async () => ({ exitCode: 1 })]);
    const monitor = new RestoreMonitor([[], [BACKEND]], [false, neverAbsent.promise], () =>
      clock.advance(60),
    );
    const pending = new Nf04RestoreCoordinator(
      new RestoreExecutionPort(execution),
      monitor,
      clock,
    ).restore({ ...INPUT, reconciliationTimeoutMs: 100 });
    await waitUntil(() => monitor.terminated.length === 1);

    expect(monitor.cancelTimeouts).toEqual([100]);
    expect(monitor.terminated).toEqual([{ identity: BACKEND, timeoutMs: 40 }]);
    clock.advance(40);
    await expect(pending).resolves.toEqual(
      expect.objectContaining({ status: 'quarantined', reason: expect.stringMatching(/deadline/) }),
    );
  });

  it('fails closed on a hung exact-exec exit proof', async () => {
    const clock = new ControlledClock();
    const firstWait = deferred<Nf04ContainerExecExit>();
    const reconciliationWait = deferred<Nf04ContainerExecExit>();
    const execution = new RestoreExecution([
      () => firstWait.promise,
      () => reconciliationWait.promise,
    ]);
    const monitor = new RestoreMonitor([[]]);
    const pending = new Nf04RestoreCoordinator(
      new RestoreExecutionPort(execution),
      monitor,
      clock,
    ).restore({ ...INPUT, timeoutMs: 100, reconciliationTimeoutMs: 50 });
    await flushMicrotasks();

    clock.advance(100);
    await flushMicrotasks();
    expect(execution.stopCount).toBe(1);
    clock.advance(50);
    await expect(pending).resolves.toEqual(
      expect.objectContaining({ status: 'quarantined', reason: expect.stringMatching(/deadline/) }),
    );
    expect(monitor.findCalls).toHaveLength(1);
  });

  it('waits for an in-flight start to be stopped before scanning or releasing quarantine', async () => {
    const clock = new ControlledClock();
    const execution = new StartRaceExecution();
    const monitor = new RestoreMonitor([[], [], []]);
    const pending = new Nf04RestoreCoordinator(
      new RestoreExecutionPort(execution),
      monitor,
      clock,
    ).restore({ ...INPUT, timeoutMs: 100, reconciliationTimeoutMs: 100 });
    await waitUntil(() => execution.startCount === 1);

    clock.advance(100);
    await waitUntil(() => execution.stopCount === 1);
    expect(monitor.findCalls).toHaveLength(1);
    expect(execution.stoppedAfterStart).toBe(false);

    execution.startAcknowledgement.resolve(undefined);
    await expect(pending).resolves.toEqual({
      status: 'settled_unknown',
      localPid: execution.localPid,
      backend: null,
    });
    expect(execution.stoppedAfterStart).toBe(true);
    expect(execution.waitCount).toBe(1);
    expect(monitor.findCalls).toHaveLength(3);
  });

  it('does not resume reconciliation when a timed-out query resolves late', async () => {
    const clock = new ControlledClock();
    const lateMatches = deferred<readonly Nf04RestoreBackendIdentity[]>();
    const execution = new RestoreExecution([async () => ({ exitCode: 1 })]);
    const monitor = new RestoreMonitor([[], lateMatches.promise]);
    const pending = new Nf04RestoreCoordinator(
      new RestoreExecutionPort(execution),
      monitor,
      clock,
    ).restore({ ...INPUT, reconciliationTimeoutMs: 100 });
    await waitUntil(() => monitor.findCalls.length === 2);

    clock.advance(100);
    await expect(pending).resolves.toEqual(expect.objectContaining({ status: 'quarantined' }));
    lateMatches.resolve([BACKEND]);
    await flushMicrotasks();
    expect(monitor.cancelled).toHaveLength(0);
    expect(monitor.findCalls).toHaveLength(2);
  });

  it('fails closed when exact-exec stop rejects and never scans for a backend', async () => {
    const execution = new RestoreExecution(
      [() => Promise.reject(new Error('wait rejected'))],
      undefined,
      () => Promise.reject(new Error('stop rejected')),
    );
    const monitor = new RestoreMonitor([[]]);
    await expect(
      new Nf04RestoreCoordinator(new RestoreExecutionPort(execution), monitor).restore(INPUT),
    ).resolves.toEqual(expect.objectContaining({ status: 'quarantined' }));
    expect(monitor.findCalls).toHaveLength(1);
  });

  it('quarantines multiple backends without signaling an ambiguous process', async () => {
    const second = { ...BACKEND, pid: 4124, backendStart: '2026-09-13T04:00:01.123456Z' };
    const execution = new RestoreExecution([async () => ({ exitCode: 1 })]);
    const monitor = new RestoreMonitor([[], [BACKEND, second]]);
    await expect(
      new Nf04RestoreCoordinator(new RestoreExecutionPort(execution), monitor).restore(INPUT),
    ).resolves.toEqual(expect.objectContaining({ status: 'quarantined' }));
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
    const query = jest.fn(async (text: string, values?: unknown[]) => {
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
        expect(text).toContain('a.backend_start=$2::timestamptz');
        expect(text).toContain('a.client_addr IS NOT DISTINCT FROM $9::inet');
        expect(values).toEqual([
          BACKEND.pid,
          BACKEND.backendStart,
          BACKEND.databaseOid,
          BACKEND.databaseName,
          BACKEND.roleOid,
          BACKEND.roleName,
          BACKEND.applicationName,
          expect.any(Number),
          BACKEND.clientAddress,
        ]);
        expect(values?.[1]).not.toBeInstanceOf(Date);
        return result(signaled ? [{ signaled: true }] : []);
      }
      if (text.includes('FROM pg_stat_activity')) {
        expect(text).toContain("to_char(a.backend_start AT TIME ZONE 'UTC'");
        expect(text).not.toMatch(/\ba\.query\b|\bquery\s+AS\b/i);
        return result(activityRows.shift() ?? []);
      }
      throw new Error('unexpected query');
    });
    const client = {
      query,
      release: jest.fn(),
    };
    return {
      query,
      connect: jest.fn(async () => client),
    } as unknown as Pool;
  }

  it('preserves all backend_start microseconds and signals the exact SQL identity', async () => {
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

  it('treats PID reuse differing only in backend_start microseconds as another process', async () => {
    let clock = 0;
    const reused = { ...BACKEND, backendStart: '2026-09-13T04:00:00.123457Z' };
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

  it.each(['cancel', 'terminate'] as const)(
    'does not dispatch a late %s signal after queued connection acquisition is aborted',
    async (action) => {
      const controller = new AbortController();
      const queuedConnection = deferred<PoolClient>();
      const client = {
        query: jest.fn(async () => result([{ signaled: true }])),
        release: jest.fn(),
      } as unknown as PoolClient;
      const pool = {
        query: jest.fn(async () =>
          result([
            {
              database_name: managerIdentity.databaseName,
              database_oid: managerIdentity.databaseOid,
              system_identifier: managerIdentity.systemIdentifier,
              current_user_name: managerIdentity.roleName,
            },
          ]),
        ),
        connect: jest.fn(() => queuedConnection.promise),
      } as unknown as Pool;
      const monitor = new PostgresNf04RestoreBackendMonitor(pool, managerIdentity);
      const pending =
        action === 'cancel'
          ? monitor.cancel(BACKEND, controller.signal, 100)
          : monitor.terminate(BACKEND, 100, controller.signal);
      await waitUntil(() => (pool.connect as jest.Mock).mock.calls.length === 1);

      controller.abort(new Error('synthetic reconciliation deadline'));
      await expect(pending).rejects.toThrow(/synthetic reconciliation deadline/i);
      queuedConnection.resolve(client);
      await flushMicrotasks();

      expect(client.query).toHaveBeenCalledTimes(0);
      expect(client.release).toHaveBeenCalledTimes(1);
      expect(client.release).toHaveBeenCalledWith();
    },
  );

  it('bounds queued control connection acquisition without a caller signal and releases the late client', async () => {
    jest.useFakeTimers();
    try {
      const queuedConnection = deferred<PoolClient>();
      const client = {
        query: jest.fn(async () => result([{ signaled: true }])),
        release: jest.fn(),
      } as unknown as PoolClient;
      const pool = {
        query: jest.fn(async () =>
          result([
            {
              database_name: managerIdentity.databaseName,
              database_oid: managerIdentity.databaseOid,
              system_identifier: managerIdentity.systemIdentifier,
              current_user_name: managerIdentity.roleName,
            },
          ]),
        ),
        connect: jest.fn(() => queuedConnection.promise),
      } as unknown as Pool;
      const monitor = new PostgresNf04RestoreBackendMonitor(
        pool,
        managerIdentity,
        10_000,
        50,
        () => 0,
      );
      const pending = monitor.cancel(BACKEND, undefined, 100);
      const outcome = pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      await waitUntil(() => (pool.connect as jest.Mock).mock.calls.length === 1);

      jest.advanceTimersByTime(100);
      await expect(outcome).resolves.toBeInstanceOf(Error);
      queuedConnection.resolve(client);
      await flushMicrotasks();

      expect(client.query).toHaveBeenCalledTimes(0);
      expect(client.release).toHaveBeenCalledTimes(1);
      expect(client.release).toHaveBeenCalledWith();
    } finally {
      jest.useRealTimers();
    }
  });

  it('releases a control client acquired after its remaining budget without dispatching SQL', async () => {
    let clock = 0;
    const queuedConnection = deferred<PoolClient>();
    const client = {
      query: jest.fn(async () => result([{ signaled: true }])),
      release: jest.fn(),
    } as unknown as PoolClient;
    const pool = {
      query: jest.fn(async () =>
        result([
          {
            database_name: managerIdentity.databaseName,
            database_oid: managerIdentity.databaseOid,
            system_identifier: managerIdentity.systemIdentifier,
            current_user_name: managerIdentity.roleName,
          },
        ]),
      ),
      connect: jest.fn(() => queuedConnection.promise),
    } as unknown as Pool;
    const monitor = new PostgresNf04RestoreBackendMonitor(
      pool,
      managerIdentity,
      10_000,
      50,
      () => clock,
    );
    const pending = monitor.cancel(BACKEND, undefined, 100);
    await waitUntil(() => (pool.connect as jest.Mock).mock.calls.length === 1);

    clock = 101;
    queuedConnection.resolve(client);
    await expect(pending).rejects.toBeInstanceOf(Error);
    expect(client.query).toHaveBeenCalledTimes(0);
    expect(client.release).toHaveBeenCalledWith(false);
  });

  it('destroys only its checked-out control client when an already dispatched signal becomes unknown', async () => {
    const controller = new AbortController();
    const inFlightQuery = deferred<QueryResult<never>>();
    const client = {
      query: jest.fn(() => inFlightQuery.promise),
      release: jest.fn(),
    } as unknown as PoolClient;
    const pool = {
      query: jest.fn(async () =>
        result([
          {
            database_name: managerIdentity.databaseName,
            database_oid: managerIdentity.databaseOid,
            system_identifier: managerIdentity.systemIdentifier,
            current_user_name: managerIdentity.roleName,
          },
        ]),
      ),
      connect: jest.fn(async () => client),
    } as unknown as Pool;
    const monitor = new PostgresNf04RestoreBackendMonitor(pool, managerIdentity);
    const pending = monitor.cancel(BACKEND, controller.signal, 100);
    await waitUntil(() => (client.query as jest.Mock).mock.calls.length === 1);

    controller.abort(new Error('synthetic query acknowledgement loss'));
    await expect(pending).rejects.toThrow(/acknowledgement loss/i);
    expect(client.release).toHaveBeenCalledWith(true);

    inFlightQuery.resolve(result([{ signaled: true }]));
    await flushMicrotasks();
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('destroys its checked-out control client when a dispatched signal query fails', async () => {
    const client = {
      query: jest.fn(async () => {
        throw new Error('synthetic control query failure');
      }),
      release: jest.fn(),
    } as unknown as PoolClient;
    const pool = {
      query: jest.fn(async () =>
        result([
          {
            database_name: managerIdentity.databaseName,
            database_oid: managerIdentity.databaseOid,
            system_identifier: managerIdentity.systemIdentifier,
            current_user_name: managerIdentity.roleName,
          },
        ]),
      ),
      connect: jest.fn(async () => client),
    } as unknown as Pool;
    const monitor = new PostgresNf04RestoreBackendMonitor(pool, managerIdentity);

    await expect(monitor.cancel(BACKEND, undefined, 100)).rejects.toThrow(
      /synthetic control query failure/i,
    );
    expect(client.release).toHaveBeenCalledWith(true);
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function observeWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('controlled async operation did not reach the expected barrier');
}

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
