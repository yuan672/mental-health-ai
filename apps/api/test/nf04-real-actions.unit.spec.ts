import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  deriveNf04ExpectedNames,
  NF04_POSTGRES_IMAGE,
  nf04ExecutableManifestSchema,
  type Nf04ExecutableManifest,
} from '../src/nf04/nf04-contract';
import type {
  Nf04ArchiveEvidence,
  Nf04ArchiveKind,
  Nf04ArchivePublicationPort,
} from '../src/nf04/nf04-archive';
import type { Nf04ContainerExecutionPort } from '../src/nf04/nf04-container-execution';
import type { Nf04AccountDeletionResult } from '../src/nf04/nf04-harness';
import { Nf04DrillHarness } from '../src/nf04/nf04-harness';
import { Nf04ManifestStore } from '../src/nf04/nf04-manifest-store';
import {
  Nf04RealActions,
  requestNf04SyntheticAccountDeletion,
  SystemNf04RealActionRuntime,
  type Nf04CreatedResources,
  type Nf04InitializedDatabases,
  type Nf04RealActionRuntime,
  type Nf04RestoreAttempt,
} from '../src/nf04/nf04-real-actions';
import type { Nf04ProcessRunner } from '../src/nf04/nf04-process';
import type { Nf04StableFileCleanupPort } from '../src/nf04/nf04-windows-file-operations';

const repositoryRoot = resolve(process.cwd(), '../..');
const createdRoots: string[] = [];

afterEach(async () => {
  for (const root of createdRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('NF-04 real drill actions', () => {
  it('uses the real login, Session, CSRF and fixed account-deletion body contract', async () => {
    const fetch = jest
      .fn<ReturnType<typeof globalThis.fetch>, Parameters<typeof globalThis.fetch>>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: {
            'set-cookie': 'mh_session=session; Path=/, mh_csrf=csrf-token; Path=/',
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(
      requestNf04SyntheticAccountDeletion({
        fetch,
        baseUrl: 'http://127.0.0.1:55433',
        origin: 'http://127.0.0.1:5173',
        userEmail: 'nf04-user@example.test',
        userPassword: 'Synthetic-NF04-Password',
        operationId: '6f040000-0000-4000-8000-000000000021',
      }),
    ).resolves.toEqual({
      status: 'confirmed',
      operationId: '6f040000-0000-4000-8000-000000000021',
    });
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:55433/account/deletion',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'content-type': 'application/json',
          cookie: expect.stringContaining('mh_session=session'),
          'x-csrf-token': 'csrf-token',
        }),
        body: JSON.stringify({
          operationId: '6f040000-0000-4000-8000-000000000021',
          currentPassword: 'Synthetic-NF04-Password',
          acknowledgeIrreversible: true,
        }),
      }),
    );
  });

  it('persists exact identities before advancing through the fixed complete action order', async () => {
    const fixture = await createFixture();
    const runtime = new ControlledRuntime(fixture.manifest);
    const report = await new Nf04DrillHarness(new Nf04RealActions(fixture.store, runtime)).run();

    expect(report).toEqual({
      status: 'passed',
      completedSteps: [
        'preflight',
        'resources_created',
        'databases_initialized',
        'source_migrated',
        'fixture_loaded',
        'pre_delete_validated',
        'pre_delete_archive_completed',
        'account_deleted',
        'post_delete_validated',
        'post_delete_archive_completed',
        'source_stopped',
        'pre_delete_restored',
        'post_delete_restored',
        'restores_validated',
        'cleanup_completed',
      ],
    });
    expect(runtime.events).toEqual([
      'preflight',
      'resource:network',
      'resource:source-volume',
      'resource:restore-volume',
      'resource:source-container',
      'resource:restore-container',
      'resources:verified',
      'database:source-control',
      'database:restore-control',
      'database:source-role',
      'database:restore-role',
      'database:source',
      'databases:verified',
      'migrate',
      'fixture',
      'validate:pre_delete',
      'exec:pre-delete:allocated',
      'exec:pre-delete:exited',
      'archive:pre-delete',
      'delete-account',
      'validate:post_delete',
      'exec:post-delete:allocated',
      'exec:post-delete:exited',
      'archive:post-delete',
      'stop-source',
      'restore-db:pre-delete',
      'restore-exec:pre-delete:allocated',
      'restore-exec:pre-delete:exited',
      'restore:pre-delete',
      'restore-db:post-delete',
      'restore-exec:post-delete:allocated',
      'restore-exec:post-delete:exited',
      'restore:post-delete',
      'validate-restores',
      'cleanup',
    ]);
    const final = await fixture.store.read();
    expect(final.state).toBe('cleaned');
    expect(final.observed.sourceContainer?.id).toBe(runtime.resources.sourceContainer.id);
    expect(final.observed.preRestoreDatabase).toEqual(runtime.preRestore);
    expect(final.observed.postRestoreDatabase).toEqual(runtime.postRestore);
    expect(final.observed.executions?.preDeleteArchive?.exitCode).toBe(0);
    expect(final.observed.executions?.preDeleteArchiveList?.exitCode).toBe(0);
    expect(final.observed.executions?.postDeleteArchiveList?.exitCode).toBe(0);
    expect(final.observed.executions?.postDeleteRestore?.exitCode).toBe(0);
    expect(runtime.cleanupManifest?.observed.sourceContainer?.id).toBe(
      runtime.resources.sourceContainer.id,
    );
  });

  it('quarantines an unknown account deletion before post-delete work starts', async () => {
    const fixture = await createFixture();
    const runtime = new ControlledRuntime(fixture.manifest);
    runtime.deletionResult = {
      status: 'unknown',
      operationId: '6f040000-0000-4000-8000-000000000021',
    };

    const report = await new Nf04DrillHarness(new Nf04RealActions(fixture.store, runtime)).run();

    expect(report).toMatchObject({
      status: 'quarantined',
      failure: { code: 'ACCOUNT_DELETION_RESULT_UNKNOWN', stage: 'account_deleted' },
    });
    expect((await fixture.store.read()).state).toBe('quarantined');
    expect(runtime.events).not.toContain('validate:post_delete');
    expect(runtime.events).not.toContain('cleanup');
  });

  it('retains an already-created exact resource identity when a later creation step fails', async () => {
    const fixture = await createFixture();
    const runtime = new ControlledRuntime(fixture.manifest);
    runtime.failAfterResource = 'network';

    const report = await new Nf04DrillHarness(new Nf04RealActions(fixture.store, runtime)).run();

    expect(report).toMatchObject({
      status: 'quarantined',
      failure: { code: 'ACTION_FAILED', stage: 'resources_created' },
    });
    const persisted = await fixture.store.read();
    expect(persisted.state).toBe('quarantined');
    expect(persisted.observed.network).toEqual(runtime.resources.network);
    expect(persisted.observed.sourceVolume).toBeUndefined();
  });

  it('rejects a late restore callback after unknown reconciliation quarantines the run', async () => {
    const fixture = await createFixture();
    const runtime = new ControlledRuntime(fixture.manifest);
    runtime.unknownRestore = 'pre-delete';

    const report = await new Nf04DrillHarness(new Nf04RealActions(fixture.store, runtime)).run();
    expect(report).toMatchObject({
      status: 'quarantined',
      failure: { code: 'PRE_DELETE_RESTORE_RESULT_UNKNOWN' },
    });
    await expect(runtime.invokeLateRestoreResult()).rejects.toThrow(
      'manifest state changed before update',
    );
    const persisted = await fixture.store.read();
    expect(persisted.state).toBe('quarantined');
    expect(persisted.observed.preRestoreDatabase).toEqual(runtime.preRestore);
    expect(persisted.observed.executions?.preDeleteRestore?.exitCode).toBeNull();
  });

  it('does not persist a side-effect error or secret value in the redacted checkpoint', async () => {
    const fixture = await createFixture();
    const runtime = new ControlledRuntime(fixture.manifest);
    runtime.failMessage = 'Synthetic-secret-that-must-not-be-written';

    const report = await new Nf04DrillHarness(new Nf04RealActions(fixture.store, runtime)).run();

    expect(report).toMatchObject({ status: 'quarantined', failure: { code: 'ACTION_FAILED' } });
    const persisted = await readFile(fixture.store.manifestPath, 'utf8');
    expect(persisted).not.toContain(runtime.failMessage);
  });

  it('fails real execution preflight before any command when the free-space bound is unmet', async () => {
    const fixture = await createFixture();
    const command = jest.fn<
      ReturnType<Nf04ProcessRunner['run']>,
      Parameters<Nf04ProcessRunner['run']>
    >();
    const runtime = new SystemNf04RealActionRuntime({
      processRunner: {
        run: command,
        start: () => {
          throw new Error('preflight must not start a process');
        },
      },
      containerExecutionPort: rejectingExecutionPort(),
      archivePublicationPort: rejectingPublicationPort(),
      stableFileCleanupPort: rejectingCleanupPort(),
      apiEntryPoint: resolve(repositoryRoot, 'apps/api/dist/src/main.js'),
      operationTimeoutMs: 120_000,
      restoreTimeoutMs: 180_000,
      reconciliationTimeoutMs: 180_000,
      availableBytes: async () => 2n * 1024n * 1024n * 1024n - 1n,
    });

    await expect(runtime.preflight(fixture.manifest)).rejects.toThrow(/free-space safety limit/i);
    expect(command).not.toHaveBeenCalled();
  });
});

function rejectingExecutionPort(): Nf04ContainerExecutionPort {
  return {
    create: async () => {
      throw new Error('execution port must not be reached');
    },
  };
}

function rejectingPublicationPort(): Nf04ArchivePublicationPort {
  return {
    publish: async () => {
      throw new Error('publication port must not be reached');
    },
  };
}

function rejectingCleanupPort(): Nf04StableFileCleanupPort {
  return {
    delete: async () => {
      throw new Error('cleanup port must not be reached');
    },
  };
}

class ControlledRuntime implements Nf04RealActionRuntime {
  readonly events: string[] = [];
  readonly resources: Nf04CreatedResources;
  readonly databases: Nf04InitializedDatabases;
  readonly preRestore = database('mh_nf04_test_pre_restore_test', 201, '222');
  readonly postRestore = database('mh_nf04_test_post_restore_test', 202, '222');
  deletionResult: Nf04AccountDeletionResult = {
    status: 'confirmed',
    operationId: '6f040000-0000-4000-8000-000000000021',
  };
  unknownRestore: Nf04ArchiveKind | undefined;
  failMessage: string | undefined;
  failAfterResource: 'network' | undefined;
  cleanupManifest: Nf04ExecutableManifest | undefined;
  private lateRestore: (() => Promise<void>) | undefined;

  constructor(manifest: Nf04ExecutableManifest) {
    const names = deriveNf04ExpectedNames(manifest.runId);
    const network = {
      id: `network-${'a'.repeat(16)}`,
      name: names.network,
      driver: 'bridge',
      labels: { 'mh.nf04.run': manifest.runId, 'mh.nf04.role': 'network' },
    };
    const volume = (name: string, role: string, suffix: string) => ({
      name,
      driver: 'local',
      mountpoint: resolve(manifest.artifactRoot, suffix),
      labels: { 'mh.nf04.run': manifest.runId, 'mh.nf04.role': role },
    });
    const container = (role: 'source' | 'restore', id: string) => ({
      id,
      name: role === 'source' ? names.sourceContainer : names.restoreContainer,
      imageId: manifest.image.expectedImageId,
      imageReference: NF04_POSTGRES_IMAGE as typeof NF04_POSTGRES_IMAGE,
      labels: { 'mh.nf04.run': manifest.runId, 'mh.nf04.role': role },
      mounts: [],
      networkNames: [names.network],
      hostPort: role === 'source' ? manifest.ports.sourceDatabase : manifest.ports.restoreDatabase,
    });
    this.resources = {
      network,
      sourceVolume: volume(names.sourceVolume, 'source', 'source-volume'),
      restoreVolume: volume(names.restoreVolume, 'restore', 'restore-volume'),
      sourceContainer: container('source', `source-${'b'.repeat(16)}`),
      restoreContainer: container('restore', `restore-${'c'.repeat(16)}`),
    };
    this.databases = {
      sourceControlDatabase: database(names.sourceControlDatabase, 101, '111'),
      restoreControlDatabase: database(names.restoreControlDatabase, 102, '222'),
      sourceDatabase: database(names.sourceDatabase, 103, '111'),
      sourceServerSystemIdentifier: '111',
      restoreServerSystemIdentifier: '222',
      sourceRoleOid: 104,
      restoreRoleOid: 105,
      executions: {
        sourceToolVersion: {
          containerId: `source-${'b'.repeat(16)}`,
          execId: `source-tool-${'e'.repeat(12)}`,
          exitCode: 0,
        },
        restoreToolVersion: {
          containerId: `restore-${'c'.repeat(16)}`,
          execId: `restore-tool-${'e'.repeat(12)}`,
          exitCode: 0,
        },
      },
    };
    this.preRestore = database(names.preRestoreDatabase, 201, '222');
    this.postRestore = database(names.postRestoreDatabase, 202, '222');
  }

  async preflight(): Promise<void> {
    this.events.push('preflight');
    if (this.failMessage) throw new Error(this.failMessage);
  }

  async createResources(
    _manifest: Nf04ExecutableManifest,
    record: (resources: Partial<Nf04CreatedResources>) => Promise<void>,
  ): Promise<Nf04CreatedResources> {
    for (const [event, partial] of [
      ['resource:network', { network: this.resources.network }],
      ['resource:source-volume', { sourceVolume: this.resources.sourceVolume }],
      ['resource:restore-volume', { restoreVolume: this.resources.restoreVolume }],
      ['resource:source-container', { sourceContainer: this.resources.sourceContainer }],
      ['resource:restore-container', { restoreContainer: this.resources.restoreContainer }],
    ] as const) {
      await record(partial);
      this.events.push(event);
      if (this.failAfterResource === 'network' && event === 'resource:network') {
        throw new Error('controlled resource creation failure');
      }
    }
    this.events.push('resources:verified');
    return this.resources;
  }

  async initializeDatabases(
    _manifest: Nf04ExecutableManifest,
    record: (databases: Partial<Nf04InitializedDatabases>) => Promise<void>,
  ): Promise<Nf04InitializedDatabases> {
    for (const [event, partial] of [
      [
        'database:source-control',
        {
          sourceControlDatabase: this.databases.sourceControlDatabase,
          sourceServerSystemIdentifier: '111',
        },
      ],
      [
        'database:restore-control',
        {
          restoreControlDatabase: this.databases.restoreControlDatabase,
          restoreServerSystemIdentifier: '222',
        },
      ],
      ['database:source-role', { sourceRoleOid: this.databases.sourceRoleOid }],
      ['database:restore-role', { restoreRoleOid: this.databases.restoreRoleOid }],
      ['database:source', { sourceDatabase: this.databases.sourceDatabase }],
    ] as const) {
      await record(partial);
      this.events.push(event);
    }
    this.events.push('databases:verified');
    return this.databases;
  }

  async migrateSourceFromZero(): Promise<string> {
    this.events.push('migrate');
    return 'd'.repeat(64);
  }
  async loadFixture(): Promise<void> {
    this.events.push('fixture');
  }
  async validateSource(
    _manifest: Nf04ExecutableManifest,
    point: 'pre_delete' | 'post_delete',
  ): Promise<void> {
    this.events.push(`validate:${point}`);
  }

  async createArchive(
    _manifest: Nf04ExecutableManifest,
    kind: Nf04ArchiveKind,
    recorder: {
      execution(evidence: {
        containerId: string;
        execId: string;
        exitCode: number | null;
      }): Promise<void>;
      verification(evidence: {
        containerId: string;
        execId: string;
        exitCode: number | null;
      }): Promise<void>;
    },
  ): Promise<Nf04ArchiveEvidence> {
    const base = {
      containerId: this.resources.sourceContainer.id,
      execId: `${kind}-${'e'.repeat(12)}`,
    };
    await recorder.execution({ ...base, exitCode: null });
    this.events.push(`exec:${kind}:allocated`);
    await recorder.execution({ ...base, exitCode: 0 });
    const verification = { ...base, execId: `${kind}-list-${'f'.repeat(12)}` };
    await recorder.verification({ ...verification, exitCode: null });
    await recorder.verification({ ...verification, exitCode: 0 });
    this.events.push(`exec:${kind}:exited`, `archive:${kind}`);
    return archive(kind);
  }

  async deleteSyntheticAccount(): Promise<Nf04AccountDeletionResult> {
    this.events.push('delete-account');
    return this.deletionResult;
  }

  async stopSource(): Promise<void> {
    this.events.push('stop-source');
  }

  async restore(
    _manifest: Nf04ExecutableManifest,
    kind: Nf04ArchiveKind,
    _evidence: Nf04ArchiveEvidence,
    recorder: {
      database(evidence: ReturnType<typeof database>): Promise<void>;
      execution(evidence: {
        containerId: string;
        execId: string;
        exitCode: number | null;
      }): Promise<void>;
      verification(evidence: {
        containerId: string;
        execId: string;
        exitCode: number | null;
      }): Promise<void>;
    },
  ): Promise<Nf04RestoreAttempt> {
    const target = kind === 'pre-delete' ? this.preRestore : this.postRestore;
    await recorder.database(target);
    this.events.push(`restore-db:${kind}`);
    await recorder.verification({
      containerId: this.resources.restoreContainer.id,
      execId: `restore-list-${kind}-${'e'.repeat(12)}`,
      exitCode: 0,
    });
    const base = {
      containerId: this.resources.restoreContainer.id,
      execId: `restore-${kind}-${'e'.repeat(12)}`,
    };
    await recorder.execution({ ...base, exitCode: null });
    this.events.push(`restore-exec:${kind}:allocated`);
    if (this.unknownRestore === kind) {
      this.lateRestore = () => recorder.execution({ ...base, exitCode: 0 });
      this.events.push(`restore:${kind}:unknown`);
      return { status: 'unknown', database: target };
    }
    await recorder.execution({ ...base, exitCode: 0 });
    this.events.push(`restore-exec:${kind}:exited`, `restore:${kind}`);
    return { status: 'completed', database: target };
  }

  async invokeLateRestoreResult(): Promise<void> {
    if (!this.lateRestore) throw new Error('late restore callback was not captured');
    await this.lateRestore();
  }

  async validateRestores(): Promise<void> {
    this.events.push('validate-restores');
  }
  async cleanup(manifest: Nf04ExecutableManifest): Promise<void> {
    this.cleanupManifest = manifest;
    this.events.push('cleanup');
  }
}

function database(name: string, oid: number, systemIdentifier: string) {
  return { name, oid, systemIdentifier };
}

function archive(kind: Nf04ArchiveKind): Nf04ArchiveEvidence {
  return {
    fileName: `${kind}.dump`,
    byteSize: kind === 'pre-delete' ? 10 : 11,
    sha256: (kind === 'pre-delete' ? 'a' : 'b').repeat(64),
    completedAt: '2026-09-13T08:00:00.000Z',
    listedWithPgRestore: true,
  };
}

async function createFixture(): Promise<{
  manifest: Nf04ExecutableManifest;
  store: Nf04ManifestStore;
}> {
  const token = Math.random().toString(16).slice(2, 10).padEnd(8, '0');
  const runId = `20260913-160000-${token}`;
  const artifactRoot = join(dirname(repositoryRoot), 'handoff', 'nf04-backup-restore', runId);
  const archivesRoot = join(artifactRoot, 'archives');
  const secretsRoot = join(artifactRoot, 'secrets');
  await mkdir(archivesRoot, { recursive: true });
  await mkdir(secretsRoot, { recursive: true });
  createdRoots.push(artifactRoot);
  const manifest = nf04ExecutableManifestSchema.parse({
    version: 1,
    runId,
    state: 'planned',
    repositoryRoot,
    artifactRoot,
    archivesRoot,
    repository: {
      commitSha: 'a'.repeat(40),
      migrationHashes: ['b'.repeat(64)],
      migrationCreatedAt: [1],
    },
    image: { reference: NF04_POSTGRES_IMAGE, expectedImageId: `sha256:${'c'.repeat(64)}` },
    ports: { sourceDatabase: 55431, restoreDatabase: 55432, isolatedApi: 55433 },
    files: {
      fixtureSecrets: join(secretsRoot, 'fixture-secrets.json'),
      sourcePgPass: join(secretsRoot, 'source.pgpass'),
      restorePgPass: join(secretsRoot, 'restore.pgpass'),
      sourceManagerPassword: join(secretsRoot, 'source-manager-password'),
      restoreManagerPassword: join(secretsRoot, 'restore-manager-password'),
      executionSecrets: join(secretsRoot, 'execution-secrets.json'),
      isolatedApiEnvironment: join(secretsRoot, 'isolated-api.env'),
    },
    observed: {},
    archives: {},
  });
  const store = new Nf04ManifestStore(join(artifactRoot, 'manifest.json'), repositoryRoot);
  await store.create(manifest);
  return { manifest, store };
}
