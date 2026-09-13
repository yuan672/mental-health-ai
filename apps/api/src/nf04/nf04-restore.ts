import type { Pool } from '@mental-health/database';
import type {
  Nf04ContainerExecIdentity,
  Nf04ContainerExecSpec,
  Nf04ContainerExecution,
  Nf04ContainerExecutionPort,
} from './nf04-container-execution';
import { readNf04DatabaseIdentity, assertNf04DatabaseIdentity } from './nf04-guards';

export type {
  Nf04ContainerExecExit,
  Nf04ContainerExecIdentity,
  Nf04ContainerExecSpec,
  Nf04ContainerExecution,
  Nf04ContainerExecutionPort,
} from './nf04-container-execution';

export type Nf04RestoreBackendIdentity = Readonly<{
  pid: number;
  backendStart: string;
  databaseName: string;
  databaseOid: number;
  roleName: string;
  roleOid: number;
  applicationName: string;
  clientAddress: string | null;
}>;

export interface Nf04RestoreBackendMonitor {
  findMatches(input: {
    databaseName: string;
    databaseOid: number;
    roleName: string;
    roleOid: number;
    applicationName: string;
    signal?: AbortSignal;
  }): Promise<readonly Nf04RestoreBackendIdentity[]>;
  cancel(identity: Nf04RestoreBackendIdentity, signal?: AbortSignal): Promise<boolean>;
  terminate(
    identity: Nf04RestoreBackendIdentity,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<boolean>;
  waitUntilAbsent(identity: Nf04RestoreBackendIdentity, signal?: AbortSignal): Promise<boolean>;
}

export class PostgresNf04RestoreBackendMonitor implements Nf04RestoreBackendMonitor {
  constructor(
    private readonly managerPool: Pool,
    private readonly managerIdentity: Readonly<{
      databaseName: string;
      databaseOid: number;
      systemIdentifier: string;
      roleName: string;
    }>,
    private readonly waitTimeoutMs = 10_000,
    private readonly pollIntervalMs = 50,
    private readonly now: () => number = () => Date.now(),
    private readonly wait: (
      milliseconds: number,
      signal?: AbortSignal,
    ) => Promise<void> = waitForInterval,
  ) {}

  async findMatches(input: {
    databaseName: string;
    databaseOid: number;
    roleName: string;
    roleOid: number;
    applicationName: string;
    signal?: AbortSignal;
  }): Promise<readonly Nf04RestoreBackendIdentity[]> {
    input.signal?.throwIfAborted();
    await this.assertManagerIdentity(input.signal);
    input.signal?.throwIfAborted();
    const result = await this.managerPool.query<{
      pid: number;
      backend_start: string;
      database_name: string;
      database_oid: number;
      role_name: string;
      role_oid: number;
      application_name: string;
      client_address: string | null;
    }>(
      `SELECT a.pid,
              to_char(a.backend_start AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS backend_start,
              d.datname AS database_name,d.oid::int AS database_oid,
              r.rolname AS role_name,r.oid::int AS role_oid,a.application_name,
              a.client_addr::text AS client_address
       FROM pg_stat_activity a
       JOIN pg_database d ON d.oid=a.datid
       JOIN pg_roles r ON r.oid=a.usesysid
       WHERE d.oid=$1 AND d.datname=$2 AND r.oid=$3 AND r.rolname=$4
         AND a.application_name=$5`,
      [input.databaseOid, input.databaseName, input.roleOid, input.roleName, input.applicationName],
    );
    input.signal?.throwIfAborted();
    return result.rows.map((row) => ({
      pid: row.pid,
      // PostgreSQL produces all six fractional digits here. Never round-trip
      // backend_start through JavaScript Date: that truncates microseconds.
      backendStart: row.backend_start,
      databaseName: row.database_name,
      databaseOid: row.database_oid,
      roleName: row.role_name,
      roleOid: row.role_oid,
      applicationName: row.application_name,
      clientAddress: row.client_address,
    }));
  }

  async cancel(identity: Nf04RestoreBackendIdentity, signal?: AbortSignal): Promise<boolean> {
    return this.signalBackend('cancel', identity, 0, signal);
  }

  async terminate(
    identity: Nf04RestoreBackendIdentity,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (timeoutMs <= 0) return false;
    return this.signalBackend('terminate', identity, timeoutMs, signal);
  }

  async waitUntilAbsent(
    identity: Nf04RestoreBackendIdentity,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const deadline = this.now() + this.waitTimeoutMs;
    while (this.now() <= deadline) {
      signal?.throwIfAborted();
      const matches = await this.findMatches({
        databaseName: identity.databaseName,
        databaseOid: identity.databaseOid,
        roleName: identity.roleName,
        roleOid: identity.roleOid,
        applicationName: identity.applicationName,
        ...(signal ? { signal } : {}),
      });
      signal?.throwIfAborted();
      if (!matches.some((match) => exactBackendIdentity(match, identity))) return true;
      await this.wait(this.pollIntervalMs, signal);
    }
    return false;
  }

  private async signalBackend(
    action: 'cancel' | 'terminate',
    identity: Nf04RestoreBackendIdentity,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    signal?.throwIfAborted();
    await this.assertManagerIdentity(signal);
    signal?.throwIfAborted();
    const operation =
      action === 'cancel'
        ? 'CASE WHEN $8::bigint=0 THEN pg_cancel_backend(a.pid) ELSE false END'
        : 'pg_terminate_backend(a.pid,$8::bigint)';
    const result = await this.managerPool.query<{ signaled: boolean }>(
      `SELECT ${operation} AS signaled
       FROM pg_stat_activity a
       JOIN pg_database d ON d.oid=a.datid
       JOIN pg_roles r ON r.oid=a.usesysid
       WHERE a.pid=$1 AND a.backend_start=$2::timestamptz
         AND d.oid=$3 AND d.datname=$4
         AND r.oid=$5 AND r.rolname=$6 AND a.application_name=$7
         AND a.client_addr IS NOT DISTINCT FROM $9::inet`,
      [
        identity.pid,
        identity.backendStart,
        identity.databaseOid,
        identity.databaseName,
        identity.roleOid,
        identity.roleName,
        identity.applicationName,
        timeoutMs,
        identity.clientAddress,
      ],
    );
    signal?.throwIfAborted();
    return result.rows.length === 1 && result.rows[0]?.signaled === true;
  }

  private async assertManagerIdentity(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const actual = await readNf04DatabaseIdentity(this.managerPool);
    signal?.throwIfAborted();
    assertNf04DatabaseIdentity(actual, this.managerIdentity);
  }
}

export interface Nf04LifecycleClock {
  now(): number;
  schedule(callback: () => void, milliseconds: number): Readonly<{ cancel(): void }>;
}

export type Nf04RestoreResult =
  | Readonly<{ status: 'completed'; localPid: number }>
  | Readonly<{
      status: 'settled_unknown';
      localPid: number;
      backend: Nf04RestoreBackendIdentity | null;
    }>
  | Readonly<{ status: 'quarantined'; localPid: number; reason: string }>;

type RestoreMatchSpec = Readonly<{
  databaseName: string;
  databaseOid: number;
  roleName: string;
  roleOid: number;
  applicationName: string;
}>;

export class Nf04RestoreCoordinator {
  constructor(
    private readonly executionPort: Nf04ContainerExecutionPort,
    private readonly backendMonitor: Nf04RestoreBackendMonitor,
    private readonly clock: Nf04LifecycleClock = systemLifecycleClock,
  ) {}

  async restore(input: {
    restoreContainerId: string;
    restoreRole: string;
    restoreRoleOid: number;
    targetDatabase: string;
    targetDatabaseOid: number;
    applicationName: string;
    archiveFileName: 'pre-delete.dump' | 'post-delete.dump';
    pgPassContainerPath: string;
    timeoutMs: number;
    reconciliationTimeoutMs: number;
    signal?: AbortSignal;
  }): Promise<Nf04RestoreResult> {
    const spec: RestoreMatchSpec = {
      databaseName: input.targetDatabase,
      databaseOid: input.targetDatabaseOid,
      roleName: input.restoreRole,
      roleOid: input.restoreRoleOid,
      applicationName: input.applicationName,
    };
    if (input.timeoutMs <= 0 || input.reconciliationTimeoutMs <= 0) {
      return { status: 'quarantined', localPid: 0, reason: 'invalid restore deadline' };
    }

    const preflight = new Nf04OperationDeadline(
      input.reconciliationTimeoutMs,
      this.clock,
      input.signal,
    );
    try {
      const before = await preflight.run((signal) =>
        this.backendMonitor.findMatches({ ...spec, signal }),
      );
      if (before.length !== 0) {
        return { status: 'quarantined', localPid: 0, reason: 'restore identity already in use' };
      }
    } catch {
      return {
        status: 'quarantined',
        localPid: 0,
        reason: 'restore preflight could not be proven',
      };
    } finally {
      preflight.close();
    }

    const executionDeadline = new Nf04OperationDeadline(input.timeoutMs, this.clock, input.signal);
    let execution: Nf04ContainerExecution | undefined;
    let startMayHaveRun = false;
    let exitProven = false;
    let successCandidate = false;
    try {
      execution = await executionDeadline.run((signal) =>
        this.executionPort.create(this.restoreExecSpec(input), signal),
      );
      if (!validExecIdentity(execution.identity, input.restoreContainerId)) {
        return {
          status: 'quarantined',
          localPid: execution.localPid,
          reason: 'container exec identity could not be proven',
        };
      }
      await executionDeadline.run((signal) => {
        startMayHaveRun = true;
        return execution!.start(signal);
      });
      const exit = await executionDeadline.run((signal) => execution!.waitForExit(signal));
      exitProven = true;
      successCandidate = exit.exitCode === 0 && !input.signal?.aborted;
    } catch {
      // Once start may have reached the container engine, only the exact exec
      // exit proof below can make reconciliation safe. A late resolution of an
      // interrupted operation cannot resume this continuation.
      if (!execution || !startMayHaveRun) {
        return {
          status: 'quarantined',
          localPid: execution?.localPid ?? 0,
          reason: 'restore execution was not started',
        };
      }
    } finally {
      executionDeadline.close();
    }

    if (!execution) {
      return { status: 'quarantined', localPid: 0, reason: 'restore execution was not created' };
    }
    return this.coordinateAfterExecution(
      execution,
      spec,
      input.reconciliationTimeoutMs,
      exitProven,
      successCandidate,
    );
  }

  private restoreExecSpec(input: {
    restoreContainerId: string;
    restoreRole: string;
    targetDatabase: string;
    applicationName: string;
    archiveFileName: 'pre-delete.dump' | 'post-delete.dump';
    pgPassContainerPath: string;
  }): Nf04ContainerExecSpec {
    return {
      containerId: input.restoreContainerId,
      executable: 'pg_restore',
      args: [
        '-h',
        '/var/run/postgresql',
        '-p',
        '5432',
        '-U',
        input.restoreRole,
        '-d',
        input.targetDatabase,
        '--single-transaction',
        '--exit-on-error',
        '--no-owner',
        '--no-privileges',
        `/nf04-input/${input.archiveFileName}`,
      ],
      environment: {
        PGPASSFILE: input.pgPassContainerPath,
        PGAPPNAME: input.applicationName,
      },
    };
  }

  private async coordinateAfterExecution(
    execution: Nf04ContainerExecution,
    spec: RestoreMatchSpec,
    timeoutMs: number,
    exitProven: boolean,
    successCandidate: boolean,
  ): Promise<Nf04RestoreResult> {
    // One caller-independent deadline covers exact-exec stop/exit proof, every
    // database scan, signal, absence wait and final same-identity exclusion.
    const deadline = new Nf04OperationDeadline(timeoutMs, this.clock);
    let backend: Nf04RestoreBackendIdentity | null = null;
    try {
      if (!exitProven) {
        await deadline.run((signal) => execution.stop(signal));
        await deadline.run((signal) => execution.waitForExit(signal));
      }

      const matches = await deadline.run((signal) =>
        this.backendMonitor.findMatches({ ...spec, signal }),
      );
      if (matches.length > 1) {
        return {
          status: 'quarantined',
          localPid: execution.localPid,
          reason: 'multiple restore backends matched the exact identity',
        };
      }
      backend = matches[0] ?? null;
      if (successCandidate && !backend) {
        return { status: 'completed', localPid: execution.localPid };
      }
      if (backend && !sameRestoreIdentity(backend, spec)) {
        return {
          status: 'quarantined',
          localPid: execution.localPid,
          reason: 'restore backend identity changed before reconciliation',
        };
      }

      if (backend) {
        await deadline.run((signal) => this.backendMonitor.cancel(backend!, signal));
        const absentAfterCancel = await deadline.run((signal) =>
          this.backendMonitor.waitUntilAbsent(backend!, signal),
        );
        if (!absentAfterCancel) {
          const remainingMs = deadline.remainingMs();
          if (remainingMs <= 0) throw new Nf04DeadlineError();
          await deadline.run((signal) =>
            this.backendMonitor.terminate(backend!, remainingMs, signal),
          );
          const absentAfterTerminate = await deadline.run((signal) =>
            this.backendMonitor.waitUntilAbsent(backend!, signal),
          );
          if (!absentAfterTerminate) {
            return {
              status: 'quarantined',
              localPid: execution.localPid,
              reason: 'exact restore backend absence could not be proven',
            };
          }
        }
      }

      // Exact exec exit means it cannot create a late connection. This final
      // full-spec scan also rejects a different PID/backend_start that reused the
      // same restore identity while the recorded backend was being settled.
      const finalMatches = await deadline.run((signal) =>
        this.backendMonitor.findMatches({ ...spec, signal }),
      );
      if (finalMatches.length !== 0) {
        return {
          status: 'quarantined',
          localPid: execution.localPid,
          reason: 'restore identity still has an active backend',
        };
      }
      return { status: 'settled_unknown', localPid: execution.localPid, backend };
    } catch {
      return {
        status: 'quarantined',
        localPid: execution.localPid,
        reason: 'restore reconciliation deadline or operation failed',
      };
    } finally {
      deadline.close();
    }
  }
}

function validExecIdentity(identity: Nf04ContainerExecIdentity, containerId: string): boolean {
  return identity.containerId === containerId && identity.execId.trim().length > 0;
}

function sameRestoreIdentity(
  actual: Nf04RestoreBackendIdentity,
  expected: RestoreMatchSpec,
): boolean {
  return (
    actual.databaseName === expected.databaseName &&
    actual.databaseOid === expected.databaseOid &&
    actual.roleName === expected.roleName &&
    actual.roleOid === expected.roleOid &&
    actual.applicationName === expected.applicationName
  );
}

function exactBackendIdentity(
  actual: Nf04RestoreBackendIdentity,
  expected: Nf04RestoreBackendIdentity,
): boolean {
  return (
    sameRestoreIdentity(actual, expected) &&
    actual.pid === expected.pid &&
    actual.backendStart === expected.backendStart &&
    actual.clientAddress === expected.clientAddress
  );
}

class Nf04DeadlineError extends Error {}

class Nf04OperationDeadline {
  private readonly controller = new AbortController();
  private readonly expiresAt: number;
  private readonly timer: Readonly<{ cancel(): void }>;
  private readonly upstreamSignal: AbortSignal | undefined;
  private readonly upstreamAbort?: () => void;

  constructor(
    timeoutMs: number,
    private readonly clock: Nf04LifecycleClock,
    upstreamSignal?: AbortSignal,
  ) {
    this.expiresAt = clock.now() + Math.max(0, timeoutMs);
    this.timer = clock.schedule(() => this.abort(new Nf04DeadlineError()), Math.max(0, timeoutMs));
    this.upstreamSignal = upstreamSignal;
    if (upstreamSignal) {
      this.upstreamAbort = () => this.abort(upstreamSignal.reason);
      if (upstreamSignal.aborted) this.upstreamAbort();
      else upstreamSignal.addEventListener('abort', this.upstreamAbort, { once: true });
    }
  }

  remainingMs(): number {
    return Math.max(0, Math.floor(this.expiresAt - this.clock.now()));
  }

  run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.controller.signal.aborted || this.remainingMs() <= 0) {
      this.abort(new Nf04DeadlineError());
      return Promise.reject(this.abortReason());
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (continuation: () => void) => {
        if (settled) return;
        settled = true;
        this.controller.signal.removeEventListener('abort', onAbort);
        continuation();
      };
      const onAbort = () => finish(() => reject(this.abortReason()));
      this.controller.signal.addEventListener('abort', onAbort, { once: true });
      let pending: Promise<T>;
      try {
        pending = operation(this.controller.signal);
      } catch (error) {
        finish(() => reject(error));
        return;
      }
      pending.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
    });
  }

  close(): void {
    this.timer.cancel();
    if (this.upstreamAbort) {
      this.upstreamSignal?.removeEventListener('abort', this.upstreamAbort);
    }
  }

  private abort(reason: unknown): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason);
  }

  private abortReason(): unknown {
    return this.controller.signal.reason ?? new Nf04DeadlineError();
  }
}

const systemLifecycleClock: Nf04LifecycleClock = {
  now: () => performance.now(),
  schedule: (callback, milliseconds) => {
    const timeout = setTimeout(callback, milliseconds);
    timeout.unref();
    return { cancel: () => clearTimeout(timeout) };
  },
};

function waitForInterval(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('NF-04 wait cancelled'));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    timeout.unref();
  });
}
