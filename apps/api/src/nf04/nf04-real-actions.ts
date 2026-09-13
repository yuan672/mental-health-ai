import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  createDatabaseClient,
  migrate,
  type DatabaseClient,
  type Pool,
  type PoolClient,
} from '@mental-health/database';
import { z } from 'zod';
import {
  Nf04ArchiveManager,
  type Nf04ArchiveEvidence,
  type Nf04ArchiveKind,
  type Nf04ArchivePublicationPort,
} from './nf04-archive';
import type {
  Nf04ContainerExecution,
  Nf04ContainerExecutionPort,
} from './nf04-container-execution';
import {
  deriveNf04ExpectedNames,
  nf04ExecutableManifestSchema,
  nf04ExecutionSecretsSchema,
  nf04FixtureSecretsSchema,
  type Nf04ExecutableManifest,
  type Nf04Manifest,
  type Nf04RunState,
} from './nf04-contract';
import {
  assertLiveNf04DockerEvidence,
  Nf04DockerInspector,
  type Nf04ContainerEvidence,
  type Nf04NetworkEvidence,
  type Nf04VolumeEvidence,
} from './nf04-docker';
import {
  NF04_FIXTURE_IDS,
  NF04_FIXTURE_VALUES,
  loadNf04Fixture,
  validateNf04FixtureInTransaction,
} from './nf04-fixture';
import {
  assertNf04ContainerEvidence,
  assertNf04DatabaseIdentity,
  assertNf04ManifestBoundary,
  assertNf04PathOwnedByRoot,
  assertNf04PlannedResourcesAbsent,
  readNf04DatabaseIdentity,
  readNf04ProtectedFile,
} from './nf04-guards';
import type {
  Nf04AccountDeletionResult,
  Nf04DrillActions,
  Nf04HarnessFailure,
} from './nf04-harness';
import { Nf04ManifestStore } from './nf04-manifest-store';
import { readNf04MigrationEvidence } from './nf04-migrations';
import {
  assertNf04FreeSpace,
  assertLoopbackPortsAvailable,
  readNf04AvailableBytes,
  type Nf04AvailableBytesReader,
} from './nf04-preparation';
import type { Nf04ProcessRunner, Nf04RunningProcess } from './nf04-process';
import {
  Nf04ReadinessDeadlineError,
  waitForNf04Readiness,
  waitForNf04ReadinessInterval,
} from './nf04-readiness';
import { Nf04RestoreCoordinator, PostgresNf04RestoreBackendMonitor } from './nf04-restore';
import {
  WindowsNf04StableFileCleanupAdapter,
  type Nf04StableFileCleanupPort,
} from './nf04-windows-file-operations';

type DatabaseEvidence = NonNullable<Nf04Manifest['observed']['sourceDatabase']>;
type ExecEvidence = NonNullable<
  NonNullable<Nf04Manifest['observed']['executions']>['preDeleteArchive']
>;

const dockerVolumeInspectSchema = z
  .array(
    z.object({
      Name: z.string(),
      Driver: z.string(),
      Mountpoint: z.string(),
      Labels: z.record(z.string(), z.string()).nullable(),
    }),
  )
  .length(1);

const dockerNetworkInspectSchema = z
  .array(
    z.object({
      Id: z.string(),
      Name: z.string(),
      Driver: z.string(),
      Labels: z.record(z.string(), z.string()).nullable(),
    }),
  )
  .length(1);

export class Nf04RealActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = Nf04RealActionError.name;
  }
}

export type Nf04CreatedResources = Readonly<{
  sourceContainer: Nf04ContainerEvidence;
  restoreContainer: Nf04ContainerEvidence;
  sourceVolume: Nf04VolumeEvidence;
  restoreVolume: Nf04VolumeEvidence;
  network: Nf04NetworkEvidence;
}>;

export type Nf04InitializedDatabases = Readonly<{
  sourceControlDatabase: DatabaseEvidence;
  restoreControlDatabase: DatabaseEvidence;
  sourceDatabase: DatabaseEvidence;
  sourceServerSystemIdentifier: string;
  restoreServerSystemIdentifier: string;
  sourceRoleOid: number;
  restoreRoleOid: number;
  executions: Readonly<{
    sourceToolVersion: ExecEvidence;
    restoreToolVersion: ExecEvidence;
  }>;
}>;

export type Nf04RestoreAttempt = Readonly<{
  status: 'completed' | 'unknown';
  database: DatabaseEvidence;
  execution?: ExecEvidence;
}>;

/**
 * Narrow side-effect boundary used by the stateful action adapter. Tests replace
 * this port; the default implementation below performs the real Docker,
 * PostgreSQL, API and archive/restore calls.
 */
export interface Nf04RealActionRuntime {
  preflight(manifest: Nf04ExecutableManifest): Promise<void>;
  createResources(
    manifest: Nf04ExecutableManifest,
    recordPartial: (resources: Partial<Nf04CreatedResources>) => Promise<void>,
  ): Promise<Nf04CreatedResources>;
  initializeDatabases(
    manifest: Nf04ExecutableManifest,
    recordPartial: (databases: Partial<Nf04Manifest['observed']>) => Promise<void>,
  ): Promise<Nf04InitializedDatabases>;
  migrateSourceFromZero(manifest: Nf04ExecutableManifest): Promise<string>;
  loadFixture(manifest: Nf04ExecutableManifest): Promise<void>;
  validateSource(
    manifest: Nf04ExecutableManifest,
    point: 'pre_delete' | 'post_delete',
  ): Promise<void>;
  createArchive(
    manifest: Nf04ExecutableManifest,
    kind: Nf04ArchiveKind,
    recorder: Readonly<{
      execution(evidence: ExecEvidence): Promise<void>;
      verification(evidence: ExecEvidence): Promise<void>;
    }>,
  ): Promise<Nf04ArchiveEvidence>;
  deleteSyntheticAccount(manifest: Nf04ExecutableManifest): Promise<Nf04AccountDeletionResult>;
  stopSource(manifest: Nf04ExecutableManifest): Promise<void>;
  restore(
    manifest: Nf04ExecutableManifest,
    kind: Nf04ArchiveKind,
    evidence: Nf04ArchiveEvidence,
    recorder: Readonly<{
      database(evidence: DatabaseEvidence): Promise<void>;
      execution(evidence: ExecEvidence): Promise<void>;
      verification(evidence: ExecEvidence): Promise<void>;
    }>,
  ): Promise<Nf04RestoreAttempt>;
  validateRestores(manifest: Nf04ExecutableManifest): Promise<void>;
  cleanup(manifest: Nf04ExecutableManifest): Promise<void>;
}

/**
 * Persists every externally relevant identity before the next lifecycle step.
 * Unknown deletion/restore outcomes are deliberately returned to the harness,
 * which quarantines and stops the workflow.
 */
export class Nf04RealActions implements Nf04DrillActions {
  constructor(
    private readonly manifestStore: Nf04ManifestStore,
    private readonly runtime: Nf04RealActionRuntime,
  ) {}

  async preflight(): Promise<void> {
    await this.runtime.preflight(await this.manifest('planned'));
  }

  async createResources(): Promise<void> {
    const current = await this.manifest('planned');
    const resources = await this.runtime.createResources(current, async (partial) => {
      await this.manifestStore.update('planned', (manifest) => ({
        ...manifest,
        observed: { ...manifest.observed, ...partial },
      }));
    });
    await this.advance('planned', 'resources_created', (manifest) => ({
      ...manifest,
      observed: { ...manifest.observed, ...resources },
    }));
  }

  async initializeDatabases(): Promise<void> {
    const initialized = await this.runtime.initializeDatabases(
      await this.manifest('resources_created'),
      async (partial) => {
        await this.manifestStore.update('resources_created', (manifest) => ({
          ...manifest,
          observed: mergeObserved(manifest.observed, partial),
        }));
      },
    );
    await this.advance('resources_created', 'databases_initialized', (manifest) => ({
      ...manifest,
      observed: { ...manifest.observed, ...initialized },
    }));
  }

  async migrateSourceFromZero(): Promise<void> {
    const schemaSha256 = await this.runtime.migrateSourceFromZero(
      await this.manifest('databases_initialized'),
    );
    await this.advance('databases_initialized', 'source_migrated', (manifest) => ({
      ...manifest,
      observed: { ...manifest.observed, sourceSchemaSha256: schemaSha256 },
    }));
  }

  async loadFixture(): Promise<void> {
    await this.runtime.loadFixture(await this.manifest('source_migrated'));
    await this.advance('source_migrated', 'fixture_loaded');
  }

  async validateSource(point: 'pre_delete' | 'post_delete'): Promise<void> {
    const state = point === 'pre_delete' ? 'fixture_loaded' : 'account_deleted';
    await this.runtime.validateSource(await this.manifest(state), point);
  }

  async createArchive(kind: Nf04ArchiveKind): Promise<Nf04ArchiveEvidence> {
    const expectedState = kind === 'pre-delete' ? 'fixture_loaded' : 'account_deleted';
    const nextState =
      kind === 'pre-delete' ? 'pre_delete_archive_completed' : 'post_delete_archive_completed';
    const executionKey = kind === 'pre-delete' ? 'preDeleteArchive' : 'postDeleteArchive';
    const verificationKey =
      kind === 'pre-delete' ? 'preDeleteArchiveList' : 'postDeleteArchiveList';
    const current = await this.manifest(expectedState);
    const evidence = await this.runtime.createArchive(current, kind, {
      execution: async (execution) => {
        await this.recordExecution(expectedState, executionKey, execution);
      },
      verification: async (execution) => {
        await this.recordExecution(expectedState, verificationKey, execution);
      },
    });
    await this.advance(expectedState, nextState, (manifest) => ({
      ...manifest,
      archives: {
        ...manifest.archives,
        ...(kind === 'pre-delete' ? { preDelete: evidence } : { postDelete: evidence }),
      },
    }));
    return evidence;
  }

  async deleteSyntheticAccount(): Promise<Nf04AccountDeletionResult> {
    const result = await this.runtime.deleteSyntheticAccount(
      await this.manifest('pre_delete_archive_completed'),
    );
    if (result.status === 'confirmed') {
      await this.advance('pre_delete_archive_completed', 'account_deleted');
    }
    return result;
  }

  async stopSource(): Promise<void> {
    await this.runtime.stopSource(await this.manifest('post_delete_archive_completed'));
  }

  async restore(
    kind: Nf04ArchiveKind,
    evidence: Nf04ArchiveEvidence,
  ): Promise<'completed' | 'unknown'> {
    const expectedState = kind === 'pre-delete' ? 'post_delete_archive_completed' : 'restoring';
    const executionKey = kind === 'pre-delete' ? 'preDeleteRestore' : 'postDeleteRestore';
    const current = await this.manifest(expectedState);
    const databaseKey = kind === 'pre-delete' ? 'preRestoreDatabase' : 'postRestoreDatabase';
    const result = await this.runtime.restore(current, kind, evidence, {
      database: async (database) => {
        await this.manifestStore.update(expectedState, (manifest) => ({
          ...manifest,
          observed: { ...manifest.observed, [databaseKey]: database },
        }));
      },
      execution: async (execution) => {
        await this.recordExecution(expectedState, executionKey, execution);
      },
      verification: async (execution) => {
        await this.recordExecution(
          expectedState,
          kind === 'pre-delete' ? 'preDeleteRestoreList' : 'postDeleteRestoreList',
          execution,
        );
      },
    });
    if (result.status !== 'completed') return 'unknown';
    await this.advance(expectedState, kind === 'pre-delete' ? 'restoring' : 'restored');
    return 'completed';
  }

  async validateRestores(): Promise<void> {
    await this.runtime.validateRestores(await this.manifest('restored'));
  }

  async cleanup(): Promise<void> {
    await this.runtime.cleanup(await this.manifest('restored'));
    await this.advance('restored', 'cleaned');
  }

  async quarantine(failure: Nf04HarnessFailure): Promise<void> {
    void failure;
    const current = await this.manifestStore.read();
    if (current.state === 'quarantined') return;
    if (current.state === 'cleaned') {
      throw new Nf04RealActionError('A cleaned NF-04 run cannot be quarantined');
    }
    await this.manifestStore.quarantine(current.state);
  }

  private async recordExecution(
    state: Nf04RunState,
    key: keyof NonNullable<Nf04Manifest['observed']['executions']>,
    execution: ExecEvidence,
  ): Promise<void> {
    await this.manifestStore.update(state, (manifest) => ({
      ...manifest,
      observed: {
        ...manifest.observed,
        executions: { ...manifest.observed.executions, [key]: execution },
      },
    }));
  }

  private async advance(
    expected: Nf04RunState,
    next: Nf04RunState,
    mutate: (manifest: Nf04Manifest) => Nf04Manifest = (manifest) => manifest,
  ): Promise<void> {
    await this.manifestStore.update(expected, (manifest) => ({ ...mutate(manifest), state: next }));
  }

  private async manifest(expectedState: Nf04RunState): Promise<Nf04ExecutableManifest> {
    const manifest = nf04ExecutableManifestSchema.parse(await this.manifestStore.read());
    if (manifest.state !== expectedState) {
      throw new Nf04RealActionError('NF-04 manifest is not at the required action state');
    }
    return manifest;
  }
}

export type Nf04RealActionsConfig = Readonly<{
  manifestStore: Nf04ManifestStore;
  processRunner: Nf04ProcessRunner;
  containerExecutionPort: Nf04ContainerExecutionPort;
  archivePublicationPort: Nf04ArchivePublicationPort;
  stableFileCleanupPort?: Nf04StableFileCleanupPort;
  apiEntryPoint: string;
  operationTimeoutMs?: number;
  restoreTimeoutMs?: number;
  reconciliationTimeoutMs?: number;
  availableBytes?: Nf04AvailableBytesReader;
}>;

export function createNf04RealActions(config: Nf04RealActionsConfig): Nf04RealActions {
  return new Nf04RealActions(
    config.manifestStore,
    new SystemNf04RealActionRuntime({
      processRunner: config.processRunner,
      containerExecutionPort: config.containerExecutionPort,
      archivePublicationPort: config.archivePublicationPort,
      stableFileCleanupPort:
        config.stableFileCleanupPort ?? new WindowsNf04StableFileCleanupAdapter(),
      apiEntryPoint: config.apiEntryPoint,
      operationTimeoutMs: config.operationTimeoutMs ?? 30_000,
      restoreTimeoutMs: config.restoreTimeoutMs ?? 180_000,
      reconciliationTimeoutMs: config.reconciliationTimeoutMs ?? 10_000,
      availableBytes: config.availableBytes ?? readNf04AvailableBytes,
    }),
  );
}

type SystemRuntimeConfig = Omit<Nf04RealActionsConfig, 'manifestStore'> & {
  operationTimeoutMs: number;
  restoreTimeoutMs: number;
  reconciliationTimeoutMs: number;
  stableFileCleanupPort: Nf04StableFileCleanupPort;
  availableBytes: Nf04AvailableBytesReader;
};

/** Real Windows/Docker/PostgreSQL implementation. The full drill is only reachable through the protected CLI. */
export class SystemNf04RealActionRuntime implements Nf04RealActionRuntime {
  private readonly dockerInspector: Nf04DockerInspector;
  private readonly archiveManager: Nf04ArchiveManager;

  constructor(private readonly config: SystemRuntimeConfig) {
    this.dockerInspector = new Nf04DockerInspector(config.processRunner);
    this.archiveManager = new Nf04ArchiveManager(
      config.containerExecutionPort,
      config.containerExecutionPort,
      config.archivePublicationPort,
    );
  }

  async preflight(manifest: Nf04ExecutableManifest): Promise<void> {
    assertNf04ManifestBoundary(manifest);
    await assertNf04FreeSpace(manifest.artifactRoot, this.config.availableBytes);
    await this.assertCleanCheckout(manifest.repositoryRoot);
    await assertLoopbackPortsAvailable([
      manifest.ports.sourceDatabase,
      manifest.ports.restoreDatabase,
      manifest.ports.isolatedApi,
    ]);
    const names = deriveNf04ExpectedNames(manifest.runId);
    const presence = await this.dockerPresence();
    assertNf04PlannedResourcesAbsent(manifest, presence);
    const [head, image, migrations] = await Promise.all([
      this.command('git', ['rev-parse', 'HEAD'], manifest.repositoryRoot),
      this.command('docker', ['image', 'inspect', '--format', '{{.Id}}', manifest.image.reference]),
      readNf04MigrationEvidence(resolve(manifest.repositoryRoot, 'database', 'migrations')),
    ]);
    if (head.trim() !== manifest.repository.commitSha)
      fail('repository head does not match manifest');
    if (image.trim() !== manifest.image.expectedImageId)
      fail('container image does not match manifest');
    if (
      JSON.stringify(migrations.map((entry) => entry.hash)) !==
        JSON.stringify(manifest.repository.migrationHashes) ||
      JSON.stringify(migrations.map((entry) => entry.createdAt)) !==
        JSON.stringify(manifest.repository.migrationCreatedAt)
    ) {
      fail('migration hashes do not match manifest');
    }
    if (
      !names.sourceDatabase.endsWith('_test') ||
      !names.restoreControlDatabase.endsWith('_test')
    ) {
      fail('derived databases are not protected test targets');
    }
  }

  async createResources(
    manifest: Nf04ExecutableManifest,
    recordPartial: (resources: Partial<Nf04CreatedResources>) => Promise<void>,
  ): Promise<Nf04CreatedResources> {
    const names = deriveNf04ExpectedNames(manifest.runId);
    const label = ['--label', `mh.nf04.run=${manifest.runId}`];
    let networkId: string;
    try {
      networkId = (
        await this.command('docker', [
          'network',
          'create',
          ...label,
          '--label',
          'mh.nf04.role=network',
          names.network,
        ])
      ).trim();
    } catch {
      networkId = (await this.inspectNetwork(names.network)).id;
    }
    const network = await this.inspectNetwork(networkId);
    if (
      network.name !== names.network ||
      network.labels['mh.nf04.run'] !== manifest.runId ||
      network.labels['mh.nf04.role'] !== 'network'
    ) {
      fail('created network identity does not match the run');
    }
    await recordPartial({ network });
    try {
      await this.command('docker', [
        'volume',
        'create',
        ...label,
        '--label',
        'mh.nf04.role=source',
        names.sourceVolume,
      ]);
    } catch {
      await this.inspectVolume(names.sourceVolume);
    }
    const sourceVolume = await this.inspectVolume(names.sourceVolume);
    if (
      sourceVolume.labels['mh.nf04.run'] !== manifest.runId ||
      sourceVolume.labels['mh.nf04.role'] !== 'source'
    ) {
      fail('created source volume identity does not match the run');
    }
    await recordPartial({ sourceVolume });
    try {
      await this.command('docker', [
        'volume',
        'create',
        ...label,
        '--label',
        'mh.nf04.role=restore',
        names.restoreVolume,
      ]);
    } catch {
      await this.inspectVolume(names.restoreVolume);
    }
    const restoreVolume = await this.inspectVolume(names.restoreVolume);
    if (
      restoreVolume.labels['mh.nf04.run'] !== manifest.runId ||
      restoreVolume.labels['mh.nf04.role'] !== 'restore'
    ) {
      fail('created restore volume identity does not match the run');
    }
    await recordPartial({ restoreVolume });
    const sourceId = await this.createPostgresContainer(manifest, 'source');
    const sourceContainer = await this.dockerInspector.inspectConfiguredContainer(sourceId);
    await recordPartial({ sourceContainer });
    assertNf04ContainerEvidence(
      {
        ...manifest,
        observed: { sourceContainer, sourceVolume, network },
      },
      'source',
    );
    const restoreId = await this.createPostgresContainer(manifest, 'restore');
    const restoreContainer = await this.dockerInspector.inspectConfiguredContainer(restoreId);
    await recordPartial({ restoreContainer });
    assertNf04ContainerEvidence(
      {
        ...manifest,
        observed: { restoreContainer, restoreVolume, network },
      },
      'restore',
    );
    await this.command('docker', ['start', sourceId, restoreId]);

    const source = await this.inspectProvisional(
      manifest,
      'source',
      sourceId,
      names.sourceVolume,
      networkId,
    );
    const restore = await this.inspectProvisional(
      manifest,
      'restore',
      restoreId,
      names.restoreVolume,
      networkId,
    );
    const withEvidence = {
      ...manifest,
      observed: {
        ...manifest.observed,
        sourceContainer: source.container,
        restoreContainer: restore.container,
        sourceVolume: source.volume,
        restoreVolume: restore.volume,
        network: source.network,
      },
    };
    assertNf04ContainerEvidence(withEvidence, 'source');
    assertNf04ContainerEvidence(withEvidence, 'restore');
    assertLiveNf04DockerEvidence(
      { container: source.container, volume: source.volume, network: source.network },
      source,
    );
    assertLiveNf04DockerEvidence(
      { container: restore.container, volume: restore.volume, network: restore.network },
      restore,
    );
    await this.assertExclusiveDockerMembership(withEvidence);
    return {
      sourceContainer: source.container,
      restoreContainer: restore.container,
      sourceVolume: source.volume,
      restoreVolume: restore.volume,
      network: source.network,
    };
  }

  async initializeDatabases(
    manifest: Nf04ExecutableManifest,
    recordPartial: (databases: Partial<Nf04Manifest['observed']>) => Promise<void>,
  ): Promise<Nf04InitializedDatabases> {
    this.assertDocker(manifest);
    const names = deriveNf04ExpectedNames(manifest.runId);
    const secrets = await this.secrets(manifest);
    const sourceManagerPassword = await this.secretText(
      manifest,
      manifest.files.sourceManagerPassword,
    );
    const restoreManagerPassword = await this.secretText(
      manifest,
      manifest.files.restoreManagerPassword,
    );
    const sourceManager = this.databaseClient(
      managerUrl(
        manifest.ports.sourceDatabase,
        names.sourceManagerRole,
        sourceManagerPassword,
        names.sourceControlDatabase,
      ),
    );
    const restoreManager = this.databaseClient(
      managerUrl(
        manifest.ports.restoreDatabase,
        names.restoreManagerRole,
        restoreManagerPassword,
        names.restoreControlDatabase,
      ),
    );
    try {
      await Promise.all([
        this.waitForDatabase(sourceManager.pool),
        this.waitForDatabase(restoreManager.pool),
      ]);
      const [sourceControl, restoreControl] = await Promise.all([
        readNf04DatabaseIdentity(sourceManager.pool),
        readNf04DatabaseIdentity(restoreManager.pool),
      ]);
      assertNf04DatabaseIdentity(sourceControl, {
        databaseName: names.sourceControlDatabase,
        systemIdentifier: sourceControl.systemIdentifier,
        roleName: names.sourceManagerRole,
      });
      assertNf04DatabaseIdentity(restoreControl, {
        databaseName: names.restoreControlDatabase,
        systemIdentifier: restoreControl.systemIdentifier,
        roleName: names.restoreManagerRole,
      });
      const [sourceVersion, restoreVersion] = await Promise.all([
        sourceManager.pool.query<{ version: string }>(
          "SELECT current_setting('server_version') AS version",
        ),
        restoreManager.pool.query<{ version: string }>(
          "SELECT current_setting('server_version') AS version",
        ),
      ]);
      if (sourceVersion.rows[0]?.version !== '18.6' || restoreVersion.rows[0]?.version !== '18.6') {
        fail('PostgreSQL server version does not match the reviewed 18.6 contract');
      }
      const sourceContainer = this.requireContainer(manifest, 'source');
      const restoreContainer = this.requireContainer(manifest, 'restore');
      const sourceToolVersion = await this.runContainerCheck(
        sourceContainer.id,
        [
          '-c',
          'test "$(pg_dump --version)" = "pg_dump (PostgreSQL) 18.6" && test "$(pg_restore --version)" = "pg_restore (PostgreSQL) 18.6"',
        ],
        async (execution) => recordPartial({ executions: { sourceToolVersion: execution } }),
      );
      const restoreToolVersion = await this.runContainerCheck(
        restoreContainer.id,
        [
          '-c',
          'test "$(pg_dump --version)" = "pg_dump (PostgreSQL) 18.6" && test "$(pg_restore --version)" = "pg_restore (PostgreSQL) 18.6"',
        ],
        async (execution) => recordPartial({ executions: { restoreToolVersion: execution } }),
      );
      await recordPartial({
        sourceControlDatabase: databaseEvidence(sourceControl),
        sourceServerSystemIdentifier: sourceControl.systemIdentifier,
      });
      await recordPartial({
        restoreControlDatabase: databaseEvidence(restoreControl),
        restoreServerSystemIdentifier: restoreControl.systemIdentifier,
      });
      await this.createRole(sourceManager.pool, names.sourceRole, secrets.sourceRolePassword);
      const sourceRoleOid = await this.roleOid(sourceManager.pool, names.sourceRole);
      await recordPartial({ sourceRoleOid });
      await this.createDatabase(sourceManager.pool, names.sourceDatabase, names.sourceRole);
      const sourceDatabase = await this.catalogDatabaseEvidence(
        sourceManager.pool,
        names.sourceDatabase,
        sourceControl.systemIdentifier,
      );
      await recordPartial({ sourceDatabase });
      await this.createRole(restoreManager.pool, names.restoreRole, secrets.restoreRolePassword);
      const restoreRoleOid = await this.roleOid(restoreManager.pool, names.restoreRole);
      await recordPartial({ restoreRoleOid });
      const fixture = await this.fixtureSecrets(manifest);
      assertExactDatabaseUrl(
        fixture.databaseUrl,
        manifest.ports.sourceDatabase,
        names.sourceRole,
        names.sourceDatabase,
        secrets.sourceRolePassword,
      );
      const source = this.databaseClient(fixture.databaseUrl);
      try {
        const identity = await readNf04DatabaseIdentity(source.pool);
        assertNf04DatabaseIdentity(identity, {
          databaseName: names.sourceDatabase,
          systemIdentifier: sourceControl.systemIdentifier,
          roleName: names.sourceRole,
        });
        if (!sameEvidence(databaseEvidence(identity), sourceDatabase)) {
          fail('source database identity changed after registration');
        }
        return {
          sourceControlDatabase: databaseEvidence(sourceControl),
          restoreControlDatabase: databaseEvidence(restoreControl),
          sourceDatabase,
          sourceServerSystemIdentifier: sourceControl.systemIdentifier,
          restoreServerSystemIdentifier: restoreControl.systemIdentifier,
          sourceRoleOid,
          restoreRoleOid,
          executions: { sourceToolVersion, restoreToolVersion },
        };
      } finally {
        await source.pool.end();
      }
    } finally {
      await Promise.all([sourceManager.pool.end(), restoreManager.pool.end()]);
    }
  }

  async migrateSourceFromZero(manifest: Nf04ExecutableManifest): Promise<string> {
    await this.assertCleanCheckout(manifest.repositoryRoot);
    await this.assertLiveDocker(manifest, 'source');
    this.requireSourceDatabase(manifest);
    const fixture = await this.fixtureSecrets(manifest);
    const client = this.databaseClient(fixture.databaseUrl);
    try {
      const identity = await readNf04DatabaseIdentity(client.pool);
      assertNf04DatabaseIdentity(identity, {
        databaseName: manifest.observed.sourceDatabase!.name,
        databaseOid: manifest.observed.sourceDatabase!.oid,
        systemIdentifier: manifest.observed.sourceServerSystemIdentifier!,
        roleName: deriveNf04ExpectedNames(manifest.runId).sourceRole,
      });
      await migrate(client.database, {
        migrationsFolder: resolve(manifest.repositoryRoot, 'database', 'migrations'),
      });
      await this.assertMigrationHead(client.pool, manifest);
      return await readSchemaSha256(client.pool);
    } finally {
      await client.pool.end();
    }
  }

  async loadFixture(manifest: Nf04ExecutableManifest): Promise<void> {
    const database = this.requireSourceDatabase(manifest);
    const fixture = await this.fixtureSecrets(manifest);
    const client = this.databaseClient(fixture.databaseUrl);
    try {
      await loadNf04Fixture({
        pool: client.pool,
        secrets: fixture,
        appEnvironment: 'test',
        expectedDatabaseName: database.name,
        expectedDatabaseOid: database.oid,
        expectedSystemIdentifier: database.systemIdentifier,
        expectedDatabaseRole: deriveNf04ExpectedNames(manifest.runId).sourceRole,
        expectedMigrationHashes: manifest.repository.migrationHashes,
      });
    } finally {
      await client.pool.end();
    }
  }

  async validateSource(
    manifest: Nf04ExecutableManifest,
    point: 'pre_delete' | 'post_delete',
  ): Promise<void> {
    const database = this.databaseClient((await this.fixtureSecrets(manifest)).databaseUrl);
    try {
      await withNf04ValidationView(database.pool, 120_000, async (client) => {
        await this.assertSourceIdentity(manifest, client);
        if (point === 'pre_delete') await validateNf04FixtureInTransaction(client);
        else await validatePostDeletionFixture(client);
      });
    } finally {
      await database.pool.end();
    }
  }

  async createArchive(
    manifest: Nf04ExecutableManifest,
    kind: Nf04ArchiveKind,
    recorder: Readonly<{
      execution(evidence: ExecEvidence): Promise<void>;
      verification(evidence: ExecEvidence): Promise<void>;
    }>,
  ): Promise<Nf04ArchiveEvidence> {
    await this.assertCleanCheckout(manifest.repositoryRoot);
    await this.assertSourceQuiescent(manifest);
    await assertNf04FreeSpace(manifest.archivesRoot, this.config.availableBytes);
    const source = this.requireContainer(manifest, 'source');
    const names = deriveNf04ExpectedNames(manifest.runId);
    const writer = new RecordingExecutionPort(
      this.config.containerExecutionPort,
      recorder.execution,
    );
    const listing = new RecordingExecutionPort(
      this.config.containerExecutionPort,
      recorder.verification,
    );
    const manager = new Nf04ArchiveManager(writer, listing, this.config.archivePublicationPort);
    return manager.create({
      kind,
      repositoryRoot: manifest.repositoryRoot,
      artifactRoot: manifest.archivesRoot,
      runArtifactRoot: manifest.artifactRoot,
      runId: manifest.runId,
      sourceContainerId: source.id,
      sourceRole: names.sourceRole,
      sourceDatabase: names.sourceDatabase,
      pgPassContainerPath: '/run/secrets/nf04-source.pgpass',
      timeoutMs: this.config.operationTimeoutMs,
      ...(kind === 'post-delete' && manifest.archives.preDelete
        ? { priorArchive: manifest.archives.preDelete }
        : {}),
    });
  }

  async deleteSyntheticAccount(
    manifest: Nf04ExecutableManifest,
  ): Promise<Nf04AccountDeletionResult> {
    const fixture = await this.fixtureSecrets(manifest);
    const environment = await this.isolatedApiEnvironment(manifest, fixture.databaseUrl);
    const expectedOrigin = `http://127.0.0.1:${manifest.ports.isolatedApi}`;
    if (environment.WEB_ORIGINS !== expectedOrigin) {
      fail('isolated API origin is outside the protected NF-04 contract');
    }
    const origin = new URL(environment.WEB_ORIGINS).origin;
    const runningApi = this.config.processRunner.start({
      executable: process.execPath,
      args: [resolve(this.config.apiEntryPoint)],
      environment,
      environmentMode: 'replace',
      workingDirectory: manifest.artifactRoot,
      timeoutMs: this.config.operationTimeoutMs * 2,
    });
    const baseUrl = expectedOrigin;
    let result: Nf04AccountDeletionResult | undefined;
    try {
      await waitForHealth(baseUrl, runningApi, this.config.operationTimeoutMs);
      result = await requestNf04SyntheticAccountDeletion({
        fetch: globalThis.fetch,
        baseUrl,
        origin,
        userEmail: fixture.userEmail,
        userPassword: fixture.userPassword,
        operationId: NF04_FIXTURE_IDS.accountDeletionOperation,
        signal: AbortSignal.timeout(this.config.operationTimeoutMs),
      });
    } finally {
      runningApi.stop();
      let stopped;
      try {
        stopped = await runningApi.result;
      } catch {
        fail('isolated API exit could not be confirmed');
      }
      if (stopped.timedOut) fail('isolated API exit could not be confirmed');
    }
    await this.assertSourceQuiescent(manifest);
    return result!;
  }

  async stopSource(manifest: Nf04ExecutableManifest): Promise<void> {
    const source = this.requireContainer(manifest, 'source');
    await this.assertLiveDocker(manifest, 'source');
    await this.assertSourceQuiescent(manifest);
    await this.command('docker', ['stop', '--time', '10', source.id]);
    await this.assertLiveDocker(manifest, 'source', 'stopped', 'source-stopped');
  }

  async restore(
    manifest: Nf04ExecutableManifest,
    kind: Nf04ArchiveKind,
    evidence: Nf04ArchiveEvidence,
    recorder: Readonly<{
      database(evidence: DatabaseEvidence): Promise<void>;
      execution(evidence: ExecEvidence): Promise<void>;
      verification(evidence: ExecEvidence): Promise<void>;
    }>,
  ): Promise<Nf04RestoreAttempt> {
    await this.assertCleanCheckout(manifest.repositoryRoot);
    await this.assertLiveDocker(manifest, 'restore', 'running', 'source-stopped');
    const restoreContainer = this.requireContainer(manifest, 'restore');
    const names = deriveNf04ExpectedNames(manifest.runId);
    const target = kind === 'pre-delete' ? names.preRestoreDatabase : names.postRestoreDatabase;
    const manager = await this.restoreManager(manifest);
    try {
      await this.assertRestoreControlIdentity(manifest, manager.pool);
      await this.createDatabase(manager.pool, target, names.restoreRole);
      const database = await this.catalogDatabaseEvidence(
        manager.pool,
        target,
        manifest.observed.restoreServerSystemIdentifier!,
      );
      await recorder.database(database);
      const restoreRolePassword = (await this.secrets(manifest)).restoreRolePassword;
      await this.assertRestoreTargetEmpty(
        manifest,
        database,
        target,
        names.restoreRole,
        restoreRolePassword,
      );
      await this.archiveManager.verify({
        repositoryRoot: manifest.repositoryRoot,
        artifactRoot: manifest.archivesRoot,
        runArtifactRoot: manifest.artifactRoot,
        runId: manifest.runId,
        evidence,
      });
      await this.assertFreshRestoreTarget(manager.pool, database, names.restoreRole);
      await this.runContainerCheck(
        restoreContainer.id,
        [
          '-c',
          `test "$(pg_restore --version)" = "pg_restore (PostgreSQL) 18.6" && exec pg_restore --list /nf04-input/${evidence.fileName} >/dev/null`,
        ],
        recorder.verification,
      );
      await this.archiveManager.verify({
        repositoryRoot: manifest.repositoryRoot,
        artifactRoot: manifest.archivesRoot,
        runArtifactRoot: manifest.artifactRoot,
        runId: manifest.runId,
        evidence,
      });
      let latestExecution: ExecEvidence | undefined;
      const recording = new RecordingExecutionPort(
        this.config.containerExecutionPort,
        async (exec) => {
          latestExecution = exec;
          await recorder.execution(exec);
        },
      );
      const coordinator = new Nf04RestoreCoordinator(
        recording,
        new PostgresNf04RestoreBackendMonitor(manager.pool, {
          databaseName: names.restoreControlDatabase,
          databaseOid: manifest.observed.restoreControlDatabase!.oid,
          systemIdentifier: manifest.observed.restoreServerSystemIdentifier!,
          roleName: names.restoreManagerRole,
        }),
        undefined,
        async () => {
          await this.assertLiveDocker(manifest, 'restore', 'running', 'source-stopped');
          await this.assertRestoreControlIdentity(manifest, manager.pool);
          await this.assertRestoreTargetEmpty(
            manifest,
            database,
            target,
            names.restoreRole,
            restoreRolePassword,
          );
          await this.assertFreshRestoreTarget(manager.pool, database, names.restoreRole);
        },
      );
      const result = await coordinator.restore({
        restoreContainerId: restoreContainer.id,
        restoreRole: names.restoreRole,
        restoreRoleOid: manifest.observed.restoreRoleOid!,
        targetDatabase: target,
        targetDatabaseOid: database.oid,
        applicationName: `nf04-${manifest.runId}-${kind}`,
        archiveFileName: evidence.fileName,
        pgPassContainerPath: '/run/secrets/nf04-restore.pgpass',
        timeoutMs: this.config.restoreTimeoutMs,
        reconciliationTimeoutMs: this.config.reconciliationTimeoutMs,
      });
      return {
        status: result.status === 'completed' ? 'completed' : 'unknown',
        database,
        ...(latestExecution ? { execution: latestExecution } : {}),
      };
    } finally {
      await manager.pool.end();
    }
  }

  async validateRestores(manifest: Nf04ExecutableManifest): Promise<void> {
    const names = deriveNf04ExpectedNames(manifest.runId);
    const password = (await this.secrets(manifest)).restoreRolePassword;
    const validations: Array<[DatabaseEvidence | undefined, string, 'pre' | 'post']> = [
      [manifest.observed.preRestoreDatabase, names.preRestoreDatabase, 'pre'],
      [manifest.observed.postRestoreDatabase, names.postRestoreDatabase, 'post'],
    ];
    const validationDeadline = Date.now() + 120_000;
    for (const [evidence, name, kind] of validations) {
      if (!evidence) fail('restored database evidence is incomplete');
      const client = this.databaseClient(
        managerUrl(manifest.ports.restoreDatabase, names.restoreRole, password, name),
      );
      try {
        const remaining = validationDeadline - Date.now();
        if (remaining <= 0) fail('restore validation total deadline expired');
        await withNf04ValidationView(client.pool, remaining, async (view) => {
          const identity = await readNf04DatabaseIdentity(view);
          assertNf04DatabaseIdentity(identity, {
            databaseName: evidence.name,
            databaseOid: evidence.oid,
            systemIdentifier: manifest.observed.restoreServerSystemIdentifier!,
            roleName: names.restoreRole,
          });
          await this.assertMigrationHead(view, manifest);
          if (
            !manifest.observed.sourceSchemaSha256 ||
            (await readSchemaSha256(view)) !== manifest.observed.sourceSchemaSha256
          ) {
            fail('restored schema does not match the exact source schema evidence');
          }
          await validateRestoredStructure(view, names.restoreRole);
          if (kind === 'pre') await validateNf04FixtureInTransaction(view);
          else await validatePostDeletionFixture(view);
        });
      } finally {
        await client.pool.end();
      }
    }
  }

  async cleanup(manifest: Nf04ExecutableManifest): Promise<void> {
    await this.assertCleanCheckout(manifest.repositoryRoot);
    await this.assertLiveDocker(manifest, 'source', 'stopped', 'source-stopped');
    await this.assertLiveDocker(manifest, 'restore', 'running', 'source-stopped');
    const source = this.requireContainer(manifest, 'source');
    const restore = this.requireContainer(manifest, 'restore');
    const executions = manifest.observed.executions;
    const expectedExecutions = [
      executions?.preDeleteArchive,
      executions?.preDeleteArchiveList,
      executions?.postDeleteArchive,
      executions?.postDeleteArchiveList,
      executions?.preDeleteRestore,
      executions?.postDeleteRestore,
      executions?.sourceToolVersion,
      executions?.restoreToolVersion,
      executions?.preDeleteRestoreList,
      executions?.postDeleteRestoreList,
    ];
    if (
      expectedExecutions.some((execution) => !execution || execution.exitCode !== 0) ||
      executions?.preDeleteArchive?.containerId !== source.id ||
      executions?.preDeleteArchiveList?.containerId !== source.id ||
      executions?.postDeleteArchive?.containerId !== source.id ||
      executions?.postDeleteArchiveList?.containerId !== source.id ||
      executions?.preDeleteRestore?.containerId !== restore.id ||
      executions?.postDeleteRestore?.containerId !== restore.id ||
      executions?.sourceToolVersion?.containerId !== source.id ||
      executions?.restoreToolVersion?.containerId !== restore.id ||
      executions?.preDeleteRestoreList?.containerId !== restore.id ||
      executions?.postDeleteRestoreList?.containerId !== restore.id
    ) {
      fail('container writer exit evidence is incomplete');
    }
    await this.assertNoRestoreConnections(manifest);
    for (const container of [source, restore]) {
      const running = await this.command('docker', [
        'inspect',
        '--format',
        '{{.State.Running}}',
        container.id,
      ]);
      if (running.trim() === 'true') {
        await this.command('docker', ['stop', '--time', '10', container.id]);
      } else if (running.trim() !== 'false') {
        fail('container running state could not be proven');
      }
      const stopped = await this.command('docker', [
        'inspect',
        '--format',
        '{{.State.Running}}',
        container.id,
      ]);
      if (stopped.trim() !== 'false') fail('container stop could not be proven');
      await this.command('docker', ['container', 'rm', container.id]);
      await this.assertDockerObjectAbsent('container', container.id, container.name);
    }
    const liveSourceVolume = await this.inspectVolume(manifest.observed.sourceVolume!.name);
    const liveRestoreVolume = await this.inspectVolume(manifest.observed.restoreVolume!.name);
    const liveNetwork = await this.inspectNetwork(manifest.observed.network!.id);
    if (
      !sameEvidence(liveSourceVolume, manifest.observed.sourceVolume!) ||
      !sameEvidence(liveRestoreVolume, manifest.observed.restoreVolume!) ||
      !sameEvidence(liveNetwork, manifest.observed.network!)
    ) {
      fail('Docker resource identity changed before cleanup');
    }
    await this.command('docker', ['volume', 'rm', manifest.observed.sourceVolume!.name]);
    await this.assertDockerObjectAbsent(
      'volume',
      manifest.observed.sourceVolume!.name,
      manifest.observed.sourceVolume!.name,
    );
    await this.command('docker', ['volume', 'rm', manifest.observed.restoreVolume!.name]);
    await this.assertDockerObjectAbsent(
      'volume',
      manifest.observed.restoreVolume!.name,
      manifest.observed.restoreVolume!.name,
    );
    await this.command('docker', ['network', 'rm', manifest.observed.network!.id]);
    await this.assertDockerObjectAbsent(
      'network',
      manifest.observed.network!.id,
      manifest.observed.network!.name,
    );
    const secretsRoot = resolve(manifest.artifactRoot, 'secrets');
    for (const targetPath of Object.values(manifest.files)) {
      await this.deleteStableFile(secretsRoot, targetPath);
    }
    for (const evidence of [manifest.archives.preDelete, manifest.archives.postDelete]) {
      if (!evidence) fail('archive evidence is incomplete at cleanup');
      await this.deleteStableFile(
        manifest.archivesRoot,
        resolve(manifest.archivesRoot, evidence.fileName),
      );
    }
  }

  private async createPostgresContainer(
    manifest: Nf04ExecutableManifest,
    role: 'source' | 'restore',
  ): Promise<string> {
    const names = deriveNf04ExpectedNames(manifest.runId);
    const source = role === 'source';
    const containerName = source ? names.sourceContainer : names.restoreContainer;
    const volumeName = source ? names.sourceVolume : names.restoreVolume;
    const managerRole = source ? names.sourceManagerRole : names.restoreManagerRole;
    const controlDatabase = source ? names.sourceControlDatabase : names.restoreControlDatabase;
    const pgpass = source ? manifest.files.sourcePgPass : manifest.files.restorePgPass;
    const password = source
      ? manifest.files.sourceManagerPassword
      : manifest.files.restoreManagerPassword;
    const port = source ? manifest.ports.sourceDatabase : manifest.ports.restoreDatabase;
    const arguments_ = [
      'container',
      'create',
      '--name',
      containerName,
      '--label',
      `mh.nf04.run=${manifest.runId}`,
      '--label',
      `mh.nf04.role=${role}`,
      '--network',
      names.network,
      '--publish',
      `127.0.0.1:${port}:5432`,
      '--mount',
      `type=volume,source=${volumeName},target=/var/lib/postgresql`,
      '--mount',
      `type=bind,source=${manifest.archivesRoot},target=${source ? '/nf04-output' : '/nf04-input'}${source ? '' : ',readonly'}`,
      '--mount',
      `type=bind,source=${pgpass},target=/run/secrets/${source ? 'nf04-source.pgpass' : 'nf04-restore.pgpass'},readonly`,
      '--mount',
      `type=bind,source=${password},target=/run/secrets/nf04-manager-password,readonly`,
      '--env',
      `POSTGRES_USER=${managerRole}`,
      '--env',
      'POSTGRES_PASSWORD_FILE=/run/secrets/nf04-manager-password',
      '--env',
      `POSTGRES_DB=${controlDatabase}`,
      manifest.image.reference,
    ];
    try {
      return (await this.command('docker', arguments_)).trim();
    } catch {
      return (await this.dockerInspector.inspectConfiguredContainer(containerName)).id;
    }
  }

  private async inspectProvisional(
    manifest: Nf04ExecutableManifest,
    role: 'source' | 'restore',
    containerId: string,
    volumeName: string,
    networkId: string,
  ) {
    const provisional = {
      ...manifest,
      observed: {
        ...(role === 'source'
          ? { sourceContainer: { id: containerId }, sourceVolume: { name: volumeName } }
          : { restoreContainer: { id: containerId }, restoreVolume: { name: volumeName } }),
        network: { id: networkId },
      },
    } as unknown as Nf04Manifest;
    return this.dockerInspector.inspectRecorded(provisional, role, undefined, 'running');
  }

  private async inspectVolume(name: string): Promise<Nf04VolumeEvidence> {
    const record = dockerVolumeInspectSchema.parse(
      JSON.parse(await this.command('docker', ['volume', 'inspect', name])),
    )[0]!;
    return {
      name: record.Name,
      driver: record.Driver,
      mountpoint: record.Mountpoint,
      labels: record.Labels ?? {},
    };
  }

  private async inspectNetwork(id: string): Promise<Nf04NetworkEvidence> {
    const record = dockerNetworkInspectSchema.parse(
      JSON.parse(await this.command('docker', ['network', 'inspect', id])),
    )[0]!;
    return {
      id: record.Id,
      name: record.Name,
      driver: record.Driver,
      labels: record.Labels ?? {},
    };
  }

  private async dockerPresence() {
    const [containers, volumes, networks] = await Promise.all([
      this.command('docker', ['container', 'ls', '--all', '--format', '{{.Names}}']),
      this.command('docker', ['volume', 'ls', '--format', '{{.Name}}']),
      this.command('docker', ['network', 'ls', '--format', '{{.Name}}']),
    ]);
    return {
      containerNames: lineSet(containers),
      volumeNames: lineSet(volumes),
      networkNames: lineSet(networks),
    };
  }

  private assertDocker(manifest: Nf04ExecutableManifest): void {
    assertNf04ContainerEvidence(manifest, 'source');
    assertNf04ContainerEvidence(manifest, 'restore');
  }

  private requireContainer(
    manifest: Nf04ExecutableManifest,
    role: 'source' | 'restore',
  ): Nf04ContainerEvidence {
    this.assertDocker(manifest);
    return (
      role === 'source' ? manifest.observed.sourceContainer : manifest.observed.restoreContainer
    )!;
  }

  private requireSourceDatabase(manifest: Nf04ExecutableManifest): DatabaseEvidence {
    const evidence = manifest.observed.sourceDatabase;
    if (!evidence) fail('source database evidence is missing');
    return evidence;
  }

  private async assertSourceIdentity(
    manifest: Nf04ExecutableManifest,
    pool: Pick<Pool, 'query'>,
  ): Promise<void> {
    const evidence = this.requireSourceDatabase(manifest);
    assertNf04DatabaseIdentity(await readNf04DatabaseIdentity(pool), {
      databaseName: evidence.name,
      databaseOid: evidence.oid,
      systemIdentifier: evidence.systemIdentifier,
      roleName: deriveNf04ExpectedNames(manifest.runId).sourceRole,
    });
    await this.assertMigrationHead(pool, manifest);
  }

  private async assertSourceQuiescent(manifest: Nf04ExecutableManifest): Promise<void> {
    const names = deriveNf04ExpectedNames(manifest.runId);
    const manager = this.databaseClient(
      managerUrl(
        manifest.ports.sourceDatabase,
        names.sourceManagerRole,
        await this.secretText(manifest, manifest.files.sourceManagerPassword),
        names.sourceControlDatabase,
      ),
    );
    try {
      const control = manifest.observed.sourceControlDatabase;
      if (!control) fail('source control database evidence is missing');
      assertNf04DatabaseIdentity(await readNf04DatabaseIdentity(manager.pool), {
        databaseName: control.name,
        databaseOid: control.oid,
        systemIdentifier: manifest.observed.sourceServerSystemIdentifier!,
        roleName: names.sourceManagerRole,
      });
      const active = await manager.pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datid=$1',
        [this.requireSourceDatabase(manifest).oid],
      );
      if (active.rows[0]?.count !== 0) fail('source database is not quiescent');
    } finally {
      await manager.pool.end();
    }
  }

  private async assertNoRestoreConnections(manifest: Nf04ExecutableManifest): Promise<void> {
    const names = deriveNf04ExpectedNames(manifest.runId);
    const manager = await this.restoreManager(manifest);
    try {
      const identity = await readNf04DatabaseIdentity(manager.pool);
      const control = manifest.observed.restoreControlDatabase;
      if (!control) fail('restore control database evidence is missing');
      assertNf04DatabaseIdentity(identity, {
        databaseName: control.name,
        databaseOid: control.oid,
        systemIdentifier: manifest.observed.restoreServerSystemIdentifier!,
        roleName: names.restoreManagerRole,
      });
      const databaseOids = [
        manifest.observed.preRestoreDatabase?.oid,
        manifest.observed.postRestoreDatabase?.oid,
      ];
      if (databaseOids.some((oid) => !oid)) fail('restore target evidence is incomplete');
      const active = await manager.pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datid=ANY($1::oid[])',
        [databaseOids],
      );
      if (active.rows[0]?.count !== 0) fail('restore targets still have active connections');
    } finally {
      await manager.pool.end();
    }
  }

  private async assertRestoreControlIdentity(
    manifest: Nf04ExecutableManifest,
    pool: Pool,
  ): Promise<void> {
    const names = deriveNf04ExpectedNames(manifest.runId);
    const control = manifest.observed.restoreControlDatabase;
    if (!control) fail('restore control database evidence is missing');
    assertNf04DatabaseIdentity(await readNf04DatabaseIdentity(pool), {
      databaseName: control.name,
      databaseOid: control.oid,
      systemIdentifier: manifest.observed.restoreServerSystemIdentifier!,
      roleName: names.restoreManagerRole,
    });
  }

  private async assertFreshRestoreTarget(
    manager: Pool,
    database: DatabaseEvidence,
    owner: string,
  ): Promise<void> {
    const catalog = await manager.query<{ owner: string; sessions: number }>(
      `SELECT pg_get_userbyid(d.datdba) AS owner,
              (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datid=d.oid) AS sessions
       FROM pg_database d WHERE d.oid=$1 AND d.datname=$2`,
      [database.oid, database.name],
    );
    if (catalog.rows[0]?.owner !== owner || catalog.rows[0]?.sessions !== 0) {
      fail('restore target is not fresh and exclusive');
    }
  }

  private async assertRestoreTargetEmpty(
    manifest: Nf04ExecutableManifest,
    expected: DatabaseEvidence,
    databaseName: string,
    owner: string,
    password: string,
  ): Promise<void> {
    const client = this.databaseClient(
      managerUrl(manifest.ports.restoreDatabase, owner, password, databaseName),
    );
    try {
      const actual = databaseEvidence(await readNf04DatabaseIdentity(client.pool));
      if (!sameEvidence(actual, expected)) {
        fail('restore target identity changed after registration');
      }
      const objects = await client.pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM pg_class c
         JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname NOT IN ('pg_catalog','information_schema')
           AND n.nspname NOT LIKE 'pg_toast%'`,
      );
      if (objects.rows[0]?.count !== 0) fail('restore target contains application objects');
    } finally {
      await client.pool.end();
    }
  }

  private async runContainerCheck(
    containerId: string,
    shellArgs: readonly string[],
    record: (evidence: ExecEvidence) => Promise<void>,
  ): Promise<ExecEvidence> {
    const operationSignal = AbortSignal.timeout(this.config.operationTimeoutMs);
    const execution = await this.config.containerExecutionPort.create(
      {
        containerId,
        executable: '/bin/sh',
        args: shellArgs,
      },
      operationSignal,
    );
    const allocated: ExecEvidence = { ...execution.identity, exitCode: null };
    await record(allocated);
    try {
      await execution.start(operationSignal);
      const terminal = await execution.waitForExit(operationSignal);
      const evidence: ExecEvidence = { ...execution.identity, exitCode: terminal.exitCode };
      await record(evidence);
      if (terminal.exitCode !== 0) fail('container-side NF-04 verification failed');
      return evidence;
    } catch (error) {
      if (error instanceof Nf04RealActionError) throw error;
      const reconciliationSignal = AbortSignal.timeout(this.config.reconciliationTimeoutMs);
      try {
        await execution.stop(reconciliationSignal);
        const terminal = await execution.waitForExit(reconciliationSignal);
        await record({ ...execution.identity, exitCode: terminal.exitCode });
      } catch {
        fail('container-side NF-04 verification exit could not be confirmed');
      }
      fail('container-side NF-04 verification was interrupted');
    }
  }

  private async deleteStableFile(root: string, targetPath: string): Promise<void> {
    const boundary = await assertNf04PathOwnedByRoot(root, targetPath, 'file');
    if (!boundary.targetIdentity) fail('protected cleanup target identity is unavailable');
    const controller = new AbortController();
    await this.config.stableFileCleanupPort.delete({
      artifactRoot: root,
      targetPath,
      rootIdentity: boundary.rootIdentity,
      parentIdentity: boundary.parentIdentity,
      targetIdentity: boundary.targetIdentity,
      signal: controller.signal,
    });
  }

  private async assertDockerObjectAbsent(
    kind: 'container' | 'volume' | 'network',
    id: string,
    name: string,
  ): Promise<void> {
    for (const identity of new Set([id, name])) {
      const result = await this.config.processRunner.run({
        executable: 'docker',
        args: [kind, 'inspect', identity],
        timeoutMs: this.config.operationTimeoutMs,
      });
      if (result.timedOut || result.exitCode === 0) {
        fail('removed Docker resource absence could not be proven');
      }
      const escaped = escapeRegExp(identity);
      const exactAbsence =
        kind === 'container'
          ? new RegExp(`No such container: ${escaped}(?:\\s|$)`, 'iu')
          : kind === 'volume'
            ? new RegExp(`No such volume: ${escaped}(?:\\s|$)`, 'iu')
            : new RegExp(`network ${escaped} not found(?:\\s|$)`, 'iu');
      if (!exactAbsence.test(result.stderr.trim())) {
        fail('removed Docker resource absence could not be proven');
      }
    }
  }

  private async assertLiveDocker(
    manifest: Nf04ExecutableManifest,
    role: 'source' | 'restore',
    expectedState: 'running' | 'stopped' = 'running',
    expectedNetworkMembership: 'both-running' | 'source-stopped' = 'both-running',
  ): Promise<void> {
    this.assertDocker(manifest);
    const live = await this.dockerInspector.inspectRecorded(
      manifest,
      role,
      undefined,
      expectedState,
    );
    const recorded = {
      container:
        role === 'source'
          ? manifest.observed.sourceContainer!
          : manifest.observed.restoreContainer!,
      volume:
        role === 'source' ? manifest.observed.sourceVolume! : manifest.observed.restoreVolume!,
      network: manifest.observed.network!,
    };
    assertLiveNf04DockerEvidence(recorded, live);
    await this.assertExclusiveDockerMembership(manifest, expectedNetworkMembership);
  }

  private async assertExclusiveDockerMembership(
    manifest: Nf04ExecutableManifest | Nf04Manifest,
    expectedNetworkMembership: 'both-running' | 'source-stopped' = 'both-running',
  ): Promise<void> {
    const source = manifest.observed.sourceContainer;
    const restore = manifest.observed.restoreContainer;
    const sourceVolume = manifest.observed.sourceVolume;
    const restoreVolume = manifest.observed.restoreVolume;
    const network = manifest.observed.network;
    if (!source || !restore || !sourceVolume || !restoreVolume || !network) {
      fail('Docker exclusivity evidence is incomplete');
    }
    const [networkRaw, sourceUsersRaw, restoreUsersRaw] = await Promise.all([
      this.command('docker', [
        'network',
        'inspect',
        '--format',
        '{{json .Containers}}',
        network.id,
      ]),
      this.command('docker', [
        'container',
        'ls',
        '--all',
        '--no-trunc',
        '--filter',
        `volume=${sourceVolume.name}`,
        '--format',
        '{{.ID}}',
      ]),
      this.command('docker', [
        'container',
        'ls',
        '--all',
        '--no-trunc',
        '--filter',
        `volume=${restoreVolume.name}`,
        '--format',
        '{{.ID}}',
      ]),
    ]);
    let members: string[];
    try {
      const parsed = JSON.parse(networkRaw) as Record<string, unknown> | null;
      members = Object.keys(parsed ?? {}).sort();
    } catch {
      fail('Docker network membership evidence is invalid');
    }
    const expectedMembers =
      expectedNetworkMembership === 'source-stopped'
        ? [restore.id]
        : [restore.id, source.id].sort();
    if (
      JSON.stringify(members!) !== JSON.stringify(expectedMembers) ||
      JSON.stringify([...lineSet(sourceUsersRaw)].sort()) !== JSON.stringify([source.id]) ||
      JSON.stringify([...lineSet(restoreUsersRaw)].sort()) !== JSON.stringify([restore.id])
    ) {
      fail('NF-04 Docker resources are not exclusive to the recorded containers');
    }
  }

  private async assertMigrationHead(
    pool: Pick<Pool, 'query'>,
    manifest: Nf04ExecutableManifest,
  ): Promise<void> {
    const result = await pool.query<{ hash: string; created_at: string }>(
      'SELECT hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY id',
    );
    if (
      result.rows.length !== manifest.repository.migrationHashes.length ||
      result.rows.some(
        (row, index) =>
          row.hash !== manifest.repository.migrationHashes[index] ||
          row.created_at !== String(manifest.repository.migrationCreatedAt[index]),
      )
    ) {
      fail('database migration head does not match the manifest');
    }
  }

  private async assertCleanCheckout(repositoryRoot: string): Promise<void> {
    const result = await this.config.processRunner.run({
      executable: 'git',
      args: ['status', '--porcelain=v1', '--untracked-files=all'],
      workingDirectory: repositoryRoot,
      timeoutMs: this.config.operationTimeoutMs,
    });
    if (result.timedOut || result.exitCode !== 0 || result.stdout.trim() !== '') {
      fail('NF-04 execution requires a clean reviewed checkout');
    }
  }

  private async createRole(pool: Pool, role: string, password: string): Promise<void> {
    await pool.query(
      `CREATE ROLE ${quoteIdentifier(role)} LOGIN PASSWORD ${quoteLiteral(password)}`,
    );
  }

  private async createDatabase(pool: Pool, database: string, owner: string): Promise<void> {
    await pool.query(
      `CREATE DATABASE ${quoteIdentifier(database)} OWNER ${quoteIdentifier(owner)}`,
    );
  }

  private async roleOid(pool: Pool, role: string): Promise<number> {
    const result = await pool.query<{ oid: number }>(
      'SELECT oid::int AS oid FROM pg_roles WHERE rolname=$1',
      [role],
    );
    const oid = result.rows[0]?.oid;
    if (!oid) fail('created database role identity is unavailable');
    return oid;
  }

  private async catalogDatabaseEvidence(
    pool: Pool,
    databaseName: string,
    systemIdentifier: string,
  ): Promise<DatabaseEvidence> {
    const result = await pool.query<{ oid: number }>(
      'SELECT oid::int AS oid FROM pg_database WHERE datname=$1',
      [databaseName],
    );
    const oid = result.rows[0]?.oid;
    if (!oid) fail('created database identity is unavailable');
    return { name: databaseName, oid, systemIdentifier };
  }

  private async restoreManager(manifest: Nf04ExecutableManifest): Promise<DatabaseClient> {
    const names = deriveNf04ExpectedNames(manifest.runId);
    return this.databaseClient(
      managerUrl(
        manifest.ports.restoreDatabase,
        names.restoreManagerRole,
        await this.secretText(manifest, manifest.files.restoreManagerPassword),
        names.restoreControlDatabase,
      ),
    );
  }

  private databaseClient(url: string): DatabaseClient {
    return createDatabaseClient(url, {
      connectionTimeoutMillis: Math.min(5_000, this.config.operationTimeoutMs),
      queryTimeoutMillis: this.config.operationTimeoutMs,
    });
  }

  private async waitForDatabase(pool: Pool): Promise<void> {
    try {
      await waitForNf04Readiness({
        timeoutMs: this.config.operationTimeoutMs,
        retryIntervalMs: 100,
        probe: async () => {
          try {
            await pool.query('SELECT 1');
            return true;
          } catch {
            return false;
          }
        },
      });
    } catch (error) {
      if (!(error instanceof Nf04ReadinessDeadlineError)) throw error;
      fail('database readiness deadline expired');
    }
  }

  private fixtureSecrets(manifest: Nf04ExecutableManifest) {
    return this.jsonSecret(manifest, manifest.files.fixtureSecrets, nf04FixtureSecretsSchema);
  }

  private secrets(manifest: Nf04ExecutableManifest) {
    return this.jsonSecret(manifest, manifest.files.executionSecrets, nf04ExecutionSecretsSchema);
  }

  private async jsonSecret<T>(
    manifest: Nf04ExecutableManifest,
    path: string,
    schema: z.ZodType<T>,
  ): Promise<T> {
    try {
      return schema.parse(JSON.parse(await this.secretText(manifest, path)));
    } catch {
      fail('protected NF-04 secret could not be parsed');
    }
  }

  private async secretText(manifest: Nf04ExecutableManifest, path: string): Promise<string> {
    return (
      await readNf04ProtectedFile({
        repositoryRoot: manifest.repositoryRoot,
        artifactRoot: manifest.artifactRoot,
        candidatePath: path,
      })
    ).trim();
  }

  private async isolatedApiEnvironment(
    manifest: Nf04ExecutableManifest,
    databaseUrl: string,
  ): Promise<Record<string, string>> {
    const raw = await this.secretText(manifest, manifest.files.isolatedApiEnvironment);
    const parsed = parseEnvironment(raw);
    if (
      parsed.APP_ENV !== 'test' ||
      parsed.NF04_ISOLATED_API !== 'true' ||
      parsed.ACCOUNT_DELETION_ENABLED !== 'true' ||
      parsed.ADMIN_AUTH_ENABLED !== 'false' ||
      parsed.AI_CHAT_ENABLED !== 'false' ||
      parsed.AI_KNOWLEDGE_ENABLED !== 'false' ||
      parsed.LLM_PROVIDER !== 'none' ||
      parsed.DATABASE_URL !== databaseUrl ||
      Number(parsed.APP_PORT) !== manifest.ports.isolatedApi
    ) {
      fail('isolated API environment is outside the protected NF-04 contract');
    }
    return parsed;
  }

  private async command(
    executable: string,
    args: readonly string[],
    workingDirectory?: string,
    allowNonzero = false,
  ): Promise<string> {
    const result = await this.config.processRunner.run({
      executable,
      args,
      ...(workingDirectory ? { workingDirectory } : {}),
      timeoutMs: this.config.operationTimeoutMs,
    });
    if (result.timedOut || (!allowNonzero && result.exitCode !== 0)) {
      fail('protected NF-04 command did not complete');
    }
    return result.stdout;
  }
}

export async function requestNf04SyntheticAccountDeletion(
  input: Readonly<{
    fetch: typeof globalThis.fetch;
    baseUrl: string;
    origin: string;
    userEmail: string;
    userPassword: string;
    operationId: string;
    signal?: AbortSignal;
  }>,
): Promise<Nf04AccountDeletionResult> {
  const login = await input.fetch(`${input.baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: input.origin },
    body: JSON.stringify({ email: input.userEmail, password: input.userPassword }),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!login.ok) fail('isolated API login did not complete');
  const cookies = readResponseCookies(login);
  const csrf = cookieValue(cookies, 'mh_csrf');
  if (!csrf || !cookies.some((cookie) => cookie.startsWith('mh_session='))) {
    fail('isolated API did not establish the protected session');
  }
  let deletion: Response;
  try {
    deletion = await input.fetch(`${input.baseUrl}/account/deletion`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: input.origin,
        cookie: cookies.map((cookie) => cookie.split(';', 1)[0]).join('; '),
        'x-csrf-token': decodeURIComponent(csrf),
      },
      body: JSON.stringify({
        operationId: input.operationId,
        currentPassword: input.userPassword,
        acknowledgeIrreversible: true,
      }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch {
    return { status: 'unknown', operationId: input.operationId };
  }
  if (deletion.status === 204) return { status: 'confirmed', operationId: input.operationId };
  if ((await safeErrorCode(deletion)) === 'ACCOUNT_DELETION_RESULT_UNKNOWN') {
    return { status: 'unknown', operationId: input.operationId };
  }
  fail('isolated account deletion did not complete');
}

class RecordingExecutionPort implements Nf04ContainerExecutionPort {
  constructor(
    private readonly delegate: Nf04ContainerExecutionPort,
    private readonly record: (evidence: ExecEvidence) => Promise<void>,
  ) {}

  async create(
    spec: Parameters<Nf04ContainerExecutionPort['create']>[0],
    signal?: AbortSignal,
  ): Promise<Nf04ContainerExecution> {
    const execution = await this.delegate.create(spec, signal);
    await this.record({ ...execution.identity, exitCode: null });
    return {
      identity: execution.identity,
      localPid: execution.localPid,
      start: (nextSignal) => execution.start(nextSignal),
      stop: (nextSignal) => execution.stop(nextSignal),
      waitForExit: async (nextSignal) => {
        const result = await execution.waitForExit(nextSignal);
        await this.record({ ...execution.identity, exitCode: result.exitCode });
        return result;
      },
    };
  }
}

async function validatePostDeletionFixture(pool: Pick<Pool, 'query'>): Promise<void> {
  const result = await pool.query<{
    user_count: number;
    risk_count: number;
    nullable_risk_links: number;
    queue_count: number;
    staff_count: number;
    knowledge_count: number;
    account_deletion_audit_count: number;
    deleted_graph_count: number;
    retained_exact_count: number;
    total_user_count: number;
    total_audit_count: number;
  }>(
    `SELECT
      (SELECT count(*)::int FROM users WHERE id=$1) AS user_count,
      (SELECT count(*)::int FROM risk_events WHERE id=$2) AS risk_count,
      (SELECT count(*)::int FROM risk_events WHERE id=$2 AND user_id IS NULL AND conversation_id IS NULL AND ai_turn_id IS NULL AND trigger_message_id IS NULL) AS nullable_risk_links,
      (SELECT count(*)::int FROM human_review_queue_items WHERE id=$3) AS queue_count,
      (SELECT count(*)::int FROM staff_principals WHERE id=$4) AS staff_count,
      (SELECT count(*)::int FROM knowledge_articles WHERE id=$5) AS knowledge_count,
      (SELECT count(*)::int FROM audit_logs WHERE action='account_deleted' AND resource_type='account_deletion' AND resource_id=$8) AS account_deletion_audit_count,
      (SELECT count(*)::int FROM users) AS total_user_count,
      (SELECT count(*)::int FROM audit_logs) AS total_audit_count,
      (SELECT sum(found)::int FROM (
         SELECT count(*)::int AS found FROM risk_events WHERE id=$2 AND risk_level='HIGH'
           AND is_incognito=false AND policy_version='nf04-fixture-v1'
           AND risk_categories=ARRAY['synthetic_fixture']::text[]
           AND reason_codes=ARRAY['SYNTHETIC_NON_CLINICAL_FIXTURE']::text[]
         UNION ALL SELECT count(*)::int FROM human_review_queue_items
           WHERE id=$3 AND risk_event_id=$2 AND priority='high' AND state='pending'
         UNION ALL SELECT count(*)::int FROM staff_principals p JOIN staff_role_grants g
           ON g.staff_principal_id=p.id WHERE p.id=$4 AND p.status='active'
           AND p.authorization_revision=1 AND g.role_key='access_administrator'
           AND g.grant_source='bootstrap' AND g.revoked_at IS NULL
         UNION ALL SELECT count(*)::int FROM knowledge_articles a
           JOIN knowledge_article_versions v ON v.article_id=a.id
           JOIN knowledge_article_sources s ON s.article_version_id=v.id
           WHERE a.id=$5 AND a.article_key=$9 AND v.id=$10
           AND v.publication_status='published' AND v.review_status='unverified'
           AND v.content_origin='synthetic_fixture' AND s.id=$11 AND s.ordinal=1
           AND s.source_url='https://fixture.invalid/nf04-source'
         UNION ALL SELECT count(*)::int FROM audit_logs WHERE id=$12
           AND action='risk_event_created' AND resource_id=$2
         UNION ALL SELECT count(*)::int FROM audit_logs WHERE id=$13
           AND action='staff_principal_bootstrapped' AND resource_id=$4
       ) retained) AS retained_exact_count,
      (SELECT sum(found)::int FROM (
         SELECT count(*)::int AS found FROM password_credentials WHERE user_id=$1
         UNION ALL SELECT count(*)::int FROM sessions WHERE user_id=$1
         UNION ALL SELECT count(*)::int FROM age_verifications WHERE user_id=$1
         UNION ALL SELECT count(*)::int FROM consents WHERE user_id=$1
         UNION ALL SELECT count(*)::int FROM consent_decisions WHERE user_id=$1
         UNION ALL SELECT count(*)::int FROM conversations WHERE user_id=$1
         UNION ALL SELECT count(*)::int FROM messages WHERE id IN ($6,$7)
         UNION ALL SELECT count(*)::int FROM assistant_message_knowledge_references WHERE assistant_message_id=$7
         UNION ALL SELECT count(*)::int FROM ai_turns WHERE user_id=$1
         UNION ALL SELECT count(*)::int FROM mood_entries WHERE user_id=$1
         UNION ALL SELECT count(*)::int FROM daily_usage_quotas WHERE user_id=$1
         UNION ALL SELECT count(*)::int FROM quota_consumptions WHERE user_id=$1
       ) deleted_graph) AS deleted_graph_count`,
    [
      NF04_FIXTURE_IDS.user,
      NF04_FIXTURE_IDS.riskEvent,
      NF04_FIXTURE_IDS.reviewQueueItem,
      NF04_FIXTURE_IDS.staffPrincipal,
      NF04_FIXTURE_IDS.knowledgeArticle,
      NF04_FIXTURE_IDS.userMessage,
      NF04_FIXTURE_IDS.assistantMessage,
      NF04_FIXTURE_IDS.accountDeletionOperation,
      NF04_FIXTURE_VALUES.knowledgeArticleKey,
      NF04_FIXTURE_IDS.knowledgeVersion,
      NF04_FIXTURE_IDS.knowledgeSource,
      NF04_FIXTURE_IDS.riskAudit,
      NF04_FIXTURE_IDS.staffAudit,
    ],
  );
  const row = result.rows[0];
  if (
    !row ||
    row.user_count !== 0 ||
    row.risk_count !== 1 ||
    row.nullable_risk_links !== 1 ||
    row.queue_count !== 1 ||
    row.staff_count !== 1 ||
    row.knowledge_count !== 1 ||
    row.account_deletion_audit_count !== 1 ||
    row.total_user_count !== 0 ||
    row.total_audit_count !== 3 ||
    row.retained_exact_count !== 6 ||
    row.deleted_graph_count !== 0
  ) {
    fail('post-deletion fixture relations do not match the fixed expectation');
  }
}

const NF04_EXPECTED_TABLES = [
  'age_verifications',
  'ai_turns',
  'assistant_message_knowledge_references',
  'audit_logs',
  'consent_decisions',
  'consents',
  'conversations',
  'daily_usage_quotas',
  'human_review_queue_items',
  'knowledge_article_sources',
  'knowledge_article_versions',
  'knowledge_articles',
  'messages',
  'mood_entries',
  'password_credentials',
  'quota_consumptions',
  'risk_events',
  'sessions',
  'staff_password_credentials',
  'staff_principals',
  'staff_role_grants',
  'staff_sessions',
  'users',
] as const;

const NF04_EXPECTED_TRIGGERS = [
  'assistant_message_knowledge_references_guard',
  'consent_decisions_append_only_trigger',
  'consent_decisions_withdrawal_target_trigger',
  'knowledge_source_evidence_immutable',
  'knowledge_version_evidence_immutable',
  'referenced_message_role_guard',
  'staff_role_grants_evidence_immutable',
] as const;

async function validateRestoredStructure(pool: PoolClient, expectedRole: string): Promise<void> {
  const [tables, triggers, constraints, relations] = await Promise.all([
    pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name",
    ),
    pool.query<{ trigger_name: string }>(
      `SELECT t.tgname AS trigger_name
       FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY t.tgname`,
    ),
    pool.query<{ invalid_count: number; primary_count: number }>(
      `SELECT count(*) FILTER (WHERE NOT convalidated)::int AS invalid_count,
              count(*) FILTER (WHERE contype='p')::int AS primary_count
       FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
       WHERE n.nspname='public'`,
    ),
    pool.query<{ wrong_owner_count: number; acl_count: number }>(
      `SELECT count(*) FILTER (WHERE r.rolname<>$1)::int AS wrong_owner_count,
              count(*) FILTER (WHERE c.relacl IS NOT NULL)::int AS acl_count
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner
       WHERE n.nspname='public' AND c.relkind IN ('r','p','S')`,
      [expectedRole],
    ),
  ]);
  if (
    JSON.stringify(tables.rows.map((row) => row.table_name)) !==
      JSON.stringify(NF04_EXPECTED_TABLES) ||
    JSON.stringify(triggers.rows.map((row) => row.trigger_name)) !==
      JSON.stringify(NF04_EXPECTED_TRIGGERS) ||
    constraints.rows[0]?.invalid_count !== 0 ||
    constraints.rows[0]?.primary_count !== NF04_EXPECTED_TABLES.length ||
    relations.rows[0]?.wrong_owner_count !== 0 ||
    relations.rows[0]?.acl_count !== 0
  ) {
    fail('restored schema, ownership, grants, constraints or triggers do not match');
  }

  await pool.query('SAVEPOINT immutable_probe');
  try {
    await pool.query('UPDATE knowledge_article_versions SET title=title || $1 WHERE id=$2', [
      'x',
      NF04_FIXTURE_IDS.knowledgeVersion,
    ]);
    fail('restored immutability trigger did not reject its rollback-only probe');
  } catch (error) {
    if (error instanceof Nf04RealActionError) throw error;
    await pool.query('ROLLBACK TO SAVEPOINT immutable_probe');
  }
  await pool.query('SAVEPOINT fk_probe');
  try {
    await pool.query(
      `INSERT INTO messages (id,conversation_id,role,content,sequence_number,created_at)
       VALUES ('6f04ffff-ffff-4fff-8fff-ffffffffffff','6f04ffff-ffff-4fff-8fff-fffffffffffe','user','x',999,now())`,
    );
    fail('restored foreign key did not reject its rollback-only probe');
  } catch (error) {
    if (error instanceof Nf04RealActionError) throw error;
    await pool.query('ROLLBACK TO SAVEPOINT fk_probe');
  }
}

async function readSchemaSha256(pool: Pick<Pool, 'query'>): Promise<string> {
  const queries = [
    `SELECT n.nspname,c.relname,a.attnum,a.attname,
            pg_catalog.format_type(a.atttypid,a.atttypmod) AS data_type,
            a.attnotnull,pg_get_expr(d.adbin,d.adrelid) AS default_expression
     FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace
     LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
     WHERE n.nspname IN ('public','drizzle') AND c.relkind IN ('r','p')
       AND a.attnum>0 AND NOT a.attisdropped
     ORDER BY n.nspname,c.relname,a.attnum`,
    `SELECT n.nspname,c.relname,k.conname,k.contype,pg_get_constraintdef(k.oid,true) AS definition
     FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname IN ('public','drizzle')
     ORDER BY n.nspname,c.relname,k.conname`,
    `SELECT schemaname,tablename,indexname,indexdef FROM pg_indexes
     WHERE schemaname IN ('public','drizzle') ORDER BY schemaname,tablename,indexname`,
    `SELECT n.nspname,c.relname,t.tgname,pg_get_triggerdef(t.oid,true) AS definition
     FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname IN ('public','drizzle') AND NOT t.tgisinternal
     ORDER BY n.nspname,c.relname,t.tgname`,
    `SELECT n.nspname,t.typname,e.enumsortorder,e.enumlabel
     FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
     JOIN pg_enum e ON e.enumtypid=t.oid
     WHERE n.nspname='public' ORDER BY t.typname,e.enumsortorder`,
  ];
  const evidence: unknown[] = [];
  for (const query of queries) evidence.push((await pool.query(query)).rows);
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}

function databaseEvidence(
  identity: Awaited<ReturnType<typeof readNf04DatabaseIdentity>>,
): DatabaseEvidence {
  return {
    name: identity.databaseName,
    oid: identity.databaseOid,
    systemIdentifier: identity.systemIdentifier,
  };
}

function managerUrl(port: number, role: string, password: string, database: string): string {
  return `postgresql://${encodeURIComponent(role)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${encodeURIComponent(database)}`;
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z0-9_]+$/u.test(value)) fail('database identifier is outside the fixed contract');
  return `"${value}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function assertExactDatabaseUrl(
  urlValue: string,
  port: number,
  role: string,
  database: string,
  password: string,
): void {
  const url = new URL(urlValue);
  if (
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    Number(url.port) !== port ||
    decodeURIComponent(url.username) !== role ||
    decodeURIComponent(url.password) !== password ||
    decodeURIComponent(url.pathname.slice(1)) !== database
  )
    fail('fixture database URL does not match the exact protected source');
}

function parseEnvironment(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) fail('isolated API environment is malformed');
    const key = trimmed.slice(0, separator);
    if (!/^[A-Z][A-Z0-9_]*$/u.test(key) || key in result)
      fail('isolated API environment is malformed');
    result[key] = trimmed.slice(separator + 1);
  }
  return result;
}

function lineSet(output: string): Set<string> {
  return new Set(
    output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

function sameEvidence(left: unknown, right: unknown): boolean {
  const stable = (_key: string, value: unknown): unknown => {
    if (Array.isArray(value)) return [...value].sort();
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return value;
  };
  return JSON.stringify(left, stable) === JSON.stringify(right, stable);
}

async function waitForHealth(
  baseUrl: string,
  process: Nf04RunningProcess,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exited = await Promise.race([
      process.result.then(() => true),
      waitForNf04ReadinessInterval(100).then(() => false),
    ]);
    if (exited) fail('isolated API exited before readiness');
    try {
      const response = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(1_000, deadline - Date.now()))),
      });
      if (response.ok) return;
    } catch {
      // The bounded readiness loop owns this expected connection refusal.
    }
  }
  fail('isolated API readiness deadline expired');
}

function readResponseCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?(): string[] };
  return headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''].filter(Boolean);
}

function cookieValue(cookies: readonly string[], name: string): string | undefined {
  for (const cookie of cookies) {
    const match = new RegExp(`(?:^|[,;]\\s*)${name}=([^;,]+)`, 'u').exec(cookie);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

async function safeErrorCode(response: Response): Promise<string | undefined> {
  try {
    const value = (await response.json()) as unknown;
    return z.object({ error: z.object({ code: z.string() }) }).safeParse(value).data?.error.code;
  } catch {
    return undefined;
  }
}

async function withNf04ValidationView<T>(
  pool: Pool,
  timeoutMs: number,
  validate: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const bounded = Math.max(1, Math.min(120_000, Math.floor(timeoutMs)));
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SELECT set_config('transaction_timeout',$1,true)", [`${bounded}ms`]);
    await client.query("SELECT set_config('statement_timeout',$1,true)", [`${bounded}ms`]);
    const result = await validate(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function fail(message: string): never {
  throw new Nf04RealActionError(message);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function mergeObserved(
  current: Nf04Manifest['observed'],
  partial: Partial<Nf04Manifest['observed']>,
): Nf04Manifest['observed'] {
  return {
    ...current,
    ...partial,
    ...(partial.executions ? { executions: { ...current.executions, ...partial.executions } } : {}),
  };
}
