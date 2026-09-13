import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { createDatabaseClient } from '@mental-health/database';
import {
  deriveNf04ExpectedNames,
  nf04ExecutableManifestSchema,
  nf04FixtureSecretsSchema,
  nf04ManifestSchema,
} from '../nf04/nf04-contract';
import {
  DockerEngineNf04ContainerExecutionPort,
  WindowsNamedPipeNf04DockerEngineClient,
} from '../nf04/nf04-docker-engine-execution';
import { assertLiveNf04DockerEvidence, Nf04DockerInspector } from '../nf04/nf04-docker';
import { loadNf04Fixture } from '../nf04/nf04-fixture';
import {
  assertNf04ContainerEvidence,
  assertNf04ManifestBoundary,
  readNf04ProtectedFile,
} from '../nf04/nf04-guards';
import { Nf04DrillHarness } from '../nf04/nf04-harness';
import { Nf04ManifestStore } from '../nf04/nf04-manifest-store';
import { readNf04MigrationHashes } from '../nf04/nf04-migrations';
import { Nf04PreparationService } from '../nf04/nf04-preparation';
import { NodeNf04ProcessRunner } from '../nf04/nf04-process';
import { createNf04RealActions } from '../nf04/nf04-real-actions';
import {
  WindowsNf04ArchivePublicationAdapter,
  WindowsNf04StableFileCleanupAdapter,
} from '../nf04/nf04-windows-file-operations';

type Nf04CliInvocation =
  | Readonly<{ command: 'validate-manifest'; manifestPath: string }>
  | Readonly<{ command: 'load-fixture'; manifestPath: string }>
  | Readonly<{
      command: 'prepare-run';
      runId: string;
      sourceDatabasePort: number;
      restoreDatabasePort: number;
      isolatedApiPort: number;
    }>
  | Readonly<{ command: 'execute-run'; manifestPath: string; runId: string }>;

const USAGE =
  'Usage: nf04:drill <validate-manifest|load-fixture> <absolute-manifest-path> | ' +
  'prepare-run <run-id> <source-db-port> <restore-db-port> <api-port> --confirm-run-id <run-id> | ' +
  'execute-run <absolute-manifest-path> --confirm-run-id <run-id>';

export function parseNf04CliInvocation(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
): Nf04CliInvocation {
  const [command, ...args] = argv;
  if ((command === 'validate-manifest' || command === 'load-fixture') && args.length === 1) {
    requireAbsolutePath(args[0]!);
    return { command, manifestPath: resolve(args[0]!) };
  }
  if (command === 'prepare-run' && args.length === 6 && args[4] === '--confirm-run-id') {
    requireTestGate(environment, 'NF04_PREPARE_ENABLED');
    if (args[0] !== args[5]) throw new Error('NF-04 run confirmation does not match');
    return {
      command,
      runId: args[0]!,
      sourceDatabasePort: parsePort(args[1]!),
      restoreDatabasePort: parsePort(args[2]!),
      isolatedApiPort: parsePort(args[3]!),
    };
  }
  if (command === 'execute-run' && args.length === 3 && args[1] === '--confirm-run-id') {
    requireTestGate(environment, 'NF04_FULL_DRILL_ENABLED');
    requireAbsolutePath(args[0]!);
    return { command, manifestPath: resolve(args[0]!), runId: args[2]! };
  }
  throw new Error(USAGE);
}

export async function runNf04DrillCommand(
  argv: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory: string = process.cwd(),
  preparationService: Nf04PreparationService = new Nf04PreparationService(
    new NodeNf04ProcessRunner(),
  ),
): Promise<boolean> {
  const invocation = parseNf04CliInvocation(argv, environment);
  const repositoryRoot = resolve(workingDirectory, '../..');

  if (invocation.command === 'prepare-run') {
    const prepared = await preparationService.prepare(repositoryRoot, {
      runId: invocation.runId,
      sourceDatabasePort: invocation.sourceDatabasePort,
      restoreDatabasePort: invocation.restoreDatabasePort,
      isolatedApiPort: invocation.isolatedApiPort,
    });
    writeSafeResult({ event: 'nf04_run_prepared', runId: prepared.runId, state: 'planned' });
    return true;
  }

  const manifest = await readManifest(invocation.manifestPath, repositoryRoot);
  if (invocation.command === 'validate-manifest') {
    writeSafeResult({
      event: 'nf04_manifest_validated',
      runId: manifest.runId,
      state: manifest.state,
    });
    return true;
  }

  if (invocation.command === 'load-fixture') {
    await loadFixture(repositoryRoot, manifest);
    writeSafeResult({ event: 'nf04_fixture_loaded', runId: manifest.runId, status: 'completed' });
    return true;
  }

  const executable = nf04ExecutableManifestSchema.parse(manifest);
  if (invocation.runId !== executable.runId) {
    throw new Error('NF-04 run confirmation does not match the manifest');
  }
  if (executable.state !== 'planned') {
    throw new Error('NF-04 full execution only starts from a planned manifest');
  }
  const processRunner = new NodeNf04ProcessRunner();
  const actions = createNf04RealActions({
    manifestStore: new Nf04ManifestStore(invocation.manifestPath, repositoryRoot),
    processRunner,
    containerExecutionPort: new DockerEngineNf04ContainerExecutionPort(
      new WindowsNamedPipeNf04DockerEngineClient(),
    ),
    archivePublicationPort: new WindowsNf04ArchivePublicationAdapter(),
    stableFileCleanupPort: new WindowsNf04StableFileCleanupAdapter(),
    apiEntryPoint: resolve(__dirname, 'run-nf04-isolated-api.js'),
    operationTimeoutMs: 120_000,
    restoreTimeoutMs: 180_000,
    reconciliationTimeoutMs: 180_000,
  });
  const report = await new Nf04DrillHarness(actions).run();
  writeSafeResult({
    event: report.status === 'passed' ? 'nf04_drill_completed' : 'nf04_drill_stopped',
    runId: executable.runId,
    status: report.status,
    completedStepCount: report.completedSteps.length,
    ...(report.status === 'passed'
      ? {}
      : { failureCode: report.failure.code, failureStage: report.failure.stage }),
  });
  return report.status === 'passed';
}

async function readManifest(manifestPath: string, repositoryRoot: string) {
  const manifest = nf04ManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  if (resolve(manifest.repositoryRoot) !== repositoryRoot) {
    throw new Error('NF-04 manifest repository root does not match this command checkout');
  }
  assertNf04ManifestBoundary(manifest);
  return manifest;
}

async function loadFixture(
  repositoryRoot: string,
  manifest: Awaited<ReturnType<typeof readManifest>>,
): Promise<void> {
  if (manifest.state !== 'source_migrated') {
    throw new Error('NF-04 fixture loading requires manifest state source_migrated');
  }
  assertNf04ContainerEvidence(manifest, 'source');
  const recorded = {
    container: manifest.observed.sourceContainer!,
    volume: manifest.observed.sourceVolume!,
    network: manifest.observed.network!,
  };
  const live = await new Nf04DockerInspector(new NodeNf04ProcessRunner()).inspectRecorded(
    manifest,
    'source',
    undefined,
    'running',
  );
  assertLiveNf04DockerEvidence(recorded, live);
  const databaseEvidence = manifest.observed.sourceDatabase;
  if (!databaseEvidence) throw new Error('NF-04 source database evidence is missing');
  const names = deriveNf04ExpectedNames(manifest.runId);
  const secrets = nf04FixtureSecretsSchema.parse(
    JSON.parse(
      await readNf04ProtectedFile({
        repositoryRoot: manifest.repositoryRoot,
        artifactRoot: manifest.artifactRoot,
        candidatePath: resolve(manifest.files.fixtureSecrets),
      }),
    ),
  );
  assertFixtureDatabaseUrl(
    secrets.databaseUrl,
    manifest.ports.sourceDatabase,
    names.sourceRole,
    names.sourceDatabase,
  );
  const migrationHashes = await readNf04MigrationHashes(
    join(repositoryRoot, 'database/migrations'),
  );
  if (migrationHashes.length === 0) {
    throw new Error('NF-04 could not determine the expected migration head');
  }
  const client = createDatabaseClient(secrets.databaseUrl, {
    connectionTimeoutMillis: 5_000,
    queryTimeoutMillis: 10_000,
  });
  try {
    await loadNf04Fixture({
      pool: client.pool,
      secrets,
      appEnvironment: process.env.APP_ENV,
      expectedDatabaseName: databaseEvidence.name,
      expectedDatabaseOid: databaseEvidence.oid,
      expectedSystemIdentifier: databaseEvidence.systemIdentifier,
      expectedDatabaseRole: names.sourceRole,
      expectedMigrationHashes: migrationHashes,
    });
  } finally {
    await client.pool.end();
  }
}

function assertFixtureDatabaseUrl(
  value: string,
  port: number,
  role: string,
  database: string,
): void {
  const url = new URL(value);
  if (
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    Number(url.port) !== port ||
    decodeURIComponent(url.username) !== role ||
    decodeURIComponent(url.pathname.slice(1)) !== database
  ) {
    throw new Error('NF-04 secret connection identity does not match the source manifest');
  }
}

function requireTestGate(environment: NodeJS.ProcessEnv, gate: string): void {
  if (environment.APP_ENV !== 'test' || environment[gate] !== 'true') {
    throw new Error(`NF-04 requires APP_ENV=test and the explicit ${gate} gate`);
  }
}

function requireAbsolutePath(value: string): void {
  if (!isAbsolute(value)) throw new Error('NF-04 requires an absolute redacted manifest path');
}

function parsePort(value: string): number {
  if (!/^\d+$/u.test(value)) throw new Error('NF-04 ports must be decimal integers');
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error('NF-04 port is outside the protected range');
  }
  return port;
}

function writeSafeResult(result: Readonly<Record<string, string | number>>): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  void runNf04DrillCommand()
    .then((successful) => {
      if (!successful) process.exitCode = 1;
    })
    .catch(() => {
      process.stderr.write(`${JSON.stringify({ event: 'nf04_command_failed' })}\n`);
      process.exitCode = 1;
    });
}
