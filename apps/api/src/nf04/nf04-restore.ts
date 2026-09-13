import type { Pool } from '@mental-health/database';
import type { Nf04ProcessRunner, Nf04RunningProcess } from './nf04-process';
import { readNf04DatabaseIdentity, assertNf04DatabaseIdentity } from './nf04-guards';

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
    await this.assertManagerIdentity();
    const result = await this.managerPool.query<{
      pid: number;
      backend_start: Date | string;
      database_name: string;
      database_oid: number;
      role_name: string;
      role_oid: number;
      application_name: string;
      client_address: string | null;
    }>(
      `SELECT a.pid,a.backend_start,d.datname AS database_name,d.oid::int AS database_oid,
              r.rolname AS role_name,r.oid::int AS role_oid,a.application_name,
              a.client_addr::text AS client_address
       FROM pg_stat_activity a
       JOIN pg_database d ON d.oid=a.datid
       JOIN pg_roles r ON r.oid=a.usesysid
       WHERE d.oid=$1 AND d.datname=$2 AND r.oid=$3 AND r.rolname=$4
         AND a.application_name=$5`,
      [input.databaseOid, input.databaseName, input.roleOid, input.roleName, input.applicationName],
    );
    return result.rows.map((row) => ({
      pid: row.pid,
      backendStart:
        row.backend_start instanceof Date
          ? row.backend_start.toISOString()
          : new Date(row.backend_start).toISOString(),
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
    await this.assertManagerIdentity();
    const operation =
      action === 'cancel'
        ? 'CASE WHEN $8::bigint=0 THEN pg_cancel_backend(a.pid) ELSE false END'
        : 'pg_terminate_backend(a.pid,$8::bigint)';
    const result = await this.managerPool.query<{ signaled: boolean }>(
      `SELECT ${operation} AS signaled
       FROM pg_stat_activity a
       JOIN pg_database d ON d.oid=a.datid
       JOIN pg_roles r ON r.oid=a.usesysid
       WHERE a.pid=$1 AND a.backend_start=$2 AND d.oid=$3 AND d.datname=$4
         AND r.oid=$5 AND r.rolname=$6 AND a.application_name=$7
         AND a.client_addr IS NOT DISTINCT FROM $9::inet`,
      [
        identity.pid,
        new Date(identity.backendStart),
        identity.databaseOid,
        identity.databaseName,
        identity.roleOid,
        identity.roleName,
        identity.applicationName,
        timeoutMs,
        identity.clientAddress,
      ],
    );
    return result.rows.length === 1 && result.rows[0]?.signaled === true;
  }

  private async assertManagerIdentity(): Promise<void> {
    const actual = await readNf04DatabaseIdentity(this.managerPool);
    assertNf04DatabaseIdentity(actual, this.managerIdentity);
  }
}

export type Nf04RestoreResult =
  | Readonly<{ status: 'completed'; localPid: number }>
  | Readonly<{
      status: 'settled_unknown';
      localPid: number;
      backend: Nf04RestoreBackendIdentity | null;
    }>
  | Readonly<{ status: 'quarantined'; localPid: number; reason: string }>;

export class Nf04RestoreCoordinator {
  constructor(
    private readonly runner: Nf04ProcessRunner,
    private readonly backendMonitor: Nf04RestoreBackendMonitor,
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
    const spec = {
      databaseName: input.targetDatabase,
      databaseOid: input.targetDatabaseOid,
      roleName: input.restoreRole,
      roleOid: input.restoreRoleOid,
      applicationName: input.applicationName,
    };
    const before = await this.backendMonitor.findMatches({
      ...spec,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (before.length !== 0) {
      return { status: 'quarantined', localPid: 0, reason: 'restore identity already in use' };
    }

    const running = this.startRestore(input);
    const result = await running.result;
    if (!result.timedOut && result.exitCode === 0 && !input.signal?.aborted) {
      const after = await this.backendMonitor.findMatches(spec);
      if (after.length === 0) return { status: 'completed', localPid: running.localPid };
    }
    // Caller cancellation must stop the launcher, but it must not cancel the
    // bounded safety reconciliation that proves the exact database writer is
    // gone. The monitor owns its independent query and wait bounds.
    return this.reconcileUnknown(running, spec, input.reconciliationTimeoutMs);
  }

  private startRestore(input: {
    restoreContainerId: string;
    restoreRole: string;
    targetDatabase: string;
    applicationName: string;
    archiveFileName: 'pre-delete.dump' | 'post-delete.dump';
    pgPassContainerPath: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Nf04RunningProcess {
    return this.runner.start({
      executable: 'docker',
      args: [
        'exec',
        '-e',
        `PGPASSFILE=${input.pgPassContainerPath}`,
        '-e',
        `PGAPPNAME=${input.applicationName}`,
        input.restoreContainerId,
        'pg_restore',
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
      timeoutMs: input.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  private async reconcileUnknown(
    running: Nf04RunningProcess,
    spec: Parameters<Nf04RestoreBackendMonitor['findMatches']>[0],
    timeoutMs: number,
  ): Promise<Nf04RestoreResult> {
    running.stop();
    // The process runner settles only after the exact local launcher exits. If its
    // result was already delivered this is an idempotent wait.
    await running.result.catch(() => undefined);
    const matches = await this.backendMonitor.findMatches(spec);
    if (matches.length > 1) {
      return {
        status: 'quarantined',
        localPid: running.localPid,
        reason: 'multiple restore backends matched the exact identity',
      };
    }
    const backend = matches[0] ?? null;
    if (!backend) {
      return { status: 'settled_unknown', localPid: running.localPid, backend: null };
    }
    if (!sameRestoreIdentity(backend, spec)) {
      return {
        status: 'quarantined',
        localPid: running.localPid,
        reason: 'restore backend identity changed before reconciliation',
      };
    }
    await this.backendMonitor.cancel(backend);
    if (await this.backendMonitor.waitUntilAbsent(backend)) {
      return { status: 'settled_unknown', localPid: running.localPid, backend };
    }
    await this.backendMonitor.terminate(backend, timeoutMs);
    if (!(await this.backendMonitor.waitUntilAbsent(backend))) {
      return {
        status: 'quarantined',
        localPid: running.localPid,
        reason: 'exact restore backend absence could not be proven',
      };
    }
    return { status: 'settled_unknown', localPid: running.localPid, backend };
  }
}

function sameRestoreIdentity(
  actual: Nf04RestoreBackendIdentity,
  expected: Omit<Parameters<Nf04RestoreBackendMonitor['findMatches']>[0], 'signal'> & {
    signal?: AbortSignal;
  },
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
