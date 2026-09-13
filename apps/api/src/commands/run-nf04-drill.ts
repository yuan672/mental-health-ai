import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { createDatabaseClient } from '@mental-health/database';
import {
  deriveNf04ExpectedNames,
  nf04FixtureSecretsSchema,
  nf04ManifestSchema,
} from '../nf04/nf04-contract';
import { assertLiveNf04DockerEvidence, Nf04DockerInspector } from '../nf04/nf04-docker';
import { loadNf04Fixture } from '../nf04/nf04-fixture';
import {
  assertNf04ContainerEvidence,
  assertNf04ManifestBoundary,
  readNf04ProtectedFile,
} from '../nf04/nf04-guards';
import { readNf04MigrationHashes } from '../nf04/nf04-migrations';
import { NodeNf04ProcessRunner } from '../nf04/nf04-process';

type Nf04Command = 'validate-manifest' | 'load-fixture';

async function run(): Promise<void> {
  const command = process.argv[2] as Nf04Command | undefined;
  const manifestArgument = process.argv[3];
  if (!command || !manifestArgument || !['validate-manifest', 'load-fixture'].includes(command)) {
    throw new Error(
      'Usage: nf04:drill <validate-manifest|load-fixture> <absolute-redacted-manifest-path>',
    );
  }
  if (!isAbsolute(manifestArgument)) {
    throw new Error('NF-04 requires an absolute redacted manifest path');
  }

  const manifestPath = resolve(manifestArgument);
  const manifest = nf04ManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  const actualRepositoryRoot = resolve(process.cwd(), '../..');
  if (resolve(manifest.repositoryRoot) !== actualRepositoryRoot) {
    throw new Error('NF-04 manifest repository root does not match this command checkout');
  }
  assertNf04ManifestBoundary(manifest);

  if (command === 'validate-manifest') {
    writeSafeResult({
      event: 'nf04_manifest_validated',
      runId: manifest.runId,
      state: manifest.state,
    });
    return;
  }

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
  );
  assertLiveNf04DockerEvidence(recorded, live);
  const databaseEvidence = manifest.observed.sourceDatabase;
  if (!databaseEvidence) throw new Error('NF-04 source database evidence is missing');
  const names = deriveNf04ExpectedNames(manifest.runId);

  const secretsPath = resolve(manifest.files.fixtureSecrets);
  const secrets = nf04FixtureSecretsSchema.parse(
    JSON.parse(
      await readNf04ProtectedFile({
        repositoryRoot: manifest.repositoryRoot,
        artifactRoot: manifest.artifactRoot,
        candidatePath: secretsPath,
      }),
    ),
  );
  const secretDatabaseName = decodeURIComponent(new URL(secrets.databaseUrl).pathname.slice(1));
  const secretUrl = new URL(secrets.databaseUrl);
  if (secretDatabaseName !== names.sourceDatabase) {
    throw new Error('NF-04 secret connection does not target the exact source database');
  }
  if (
    !['127.0.0.1', 'localhost'].includes(secretUrl.hostname) ||
    Number(secretUrl.port) !== manifest.ports.sourceDatabase ||
    decodeURIComponent(secretUrl.username) !== names.sourceRole
  ) {
    throw new Error('NF-04 secret connection identity does not match the source manifest');
  }
  const migrationHashes = await readNf04MigrationHashes(
    join(manifest.repositoryRoot, 'database/migrations'),
  );
  if (migrationHashes.length === 0) {
    throw new Error('NF-04 could not determine the expected migration head');
  }

  const client = createDatabaseClient(secrets.databaseUrl, {
    connectionTimeoutMillis: 5_000,
    queryTimeoutMillis: 10_000,
  });
  try {
    const result = await loadNf04Fixture({
      pool: client.pool,
      secrets,
      appEnvironment: process.env.APP_ENV,
      expectedDatabaseName: databaseEvidence.name,
      expectedDatabaseOid: databaseEvidence.oid,
      expectedSystemIdentifier: databaseEvidence.systemIdentifier,
      expectedDatabaseRole: names.sourceRole,
      expectedMigrationHashes: migrationHashes,
    });
    writeSafeResult({
      event: 'nf04_fixture_loaded',
      runId: manifest.runId,
      status: result.status,
    });
  } finally {
    await client.pool.end();
  }
}

function writeSafeResult(result: Readonly<Record<string, string>>): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

void run().catch(() => {
  process.stderr.write(`${JSON.stringify({ event: 'nf04_command_failed' })}\n`);
  process.exitCode = 1;
});
