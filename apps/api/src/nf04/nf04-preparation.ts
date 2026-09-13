import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, statfs } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import {
  deriveNf04ExpectedNames,
  NF04_ARTIFACT_ROOT_NAME,
  NF04_MANIFEST_VERSION,
  NF04_MIN_FREE_BYTES,
  NF04_POSTGRES_IMAGE,
  nf04ExecutionSecretsSchema,
  nf04FixtureSecretsSchema,
  nf04ManifestSchema,
  nf04PreparationRequestSchema,
  type Nf04Manifest,
  type Nf04PreparationRequest,
} from './nf04-contract';
import { Nf04GuardError } from './nf04-guards';
import { Nf04ManifestStore } from './nf04-manifest-store';
import { readNf04MigrationEvidence } from './nf04-migrations';
import type { Nf04ProcessRunner } from './nf04-process';

export class Nf04PreparationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = Nf04PreparationError.name;
  }
}

export type Nf04PreparedRun = Readonly<{
  manifestPath: string;
  runId: string;
}>;

export type Nf04AvailableBytesReader = (path: string) => Promise<bigint>;

export const readNf04AvailableBytes: Nf04AvailableBytesReader = async (path) => {
  const stats = await statfs(path, { bigint: true });
  return stats.bavail * stats.bsize;
};

export async function assertNf04FreeSpace(
  path: string,
  availableBytes: Nf04AvailableBytesReader,
): Promise<void> {
  if ((await availableBytes(path)) < BigInt(NF04_MIN_FREE_BYTES)) {
    throw new Nf04PreparationError('NF-04 free-space safety limit is not satisfied');
  }
}

/**
 * Creates only the protected, reviewable run material. It deliberately does
 * not create or start Docker resources and never invokes the drill harness.
 */
export class Nf04PreparationService {
  constructor(
    private readonly runner: Nf04ProcessRunner,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly availableBytes: Nf04AvailableBytesReader = readNf04AvailableBytes,
  ) {}

  async prepare(
    repositoryRoot: string,
    requestInput: Nf04PreparationRequest,
  ): Promise<Nf04PreparedRun> {
    if (this.platform !== 'win32') {
      throw new Nf04PreparationError('NF-04 preparation is supported only on the reviewed host');
    }
    if (process.env.APP_ENV !== 'test' || process.env.NF04_PREPARE_ENABLED !== 'true') {
      throw new Nf04PreparationError('NF-04 preparation requires the explicit test-only gate');
    }
    const request = nf04PreparationRequestSchema.parse(requestInput);
    const repository = resolve(repositoryRoot);
    const status = await this.runner.run({
      executable: 'git',
      args: ['status', '--porcelain=v1', '--untracked-files=all'],
      workingDirectory: repository,
      timeoutMs: 10_000,
    });
    if (status.timedOut || status.exitCode !== 0 || status.stdout.trim() !== '') {
      throw new Nf04PreparationError('NF-04 preparation requires a clean reviewed checkout');
    }
    const names = deriveNf04ExpectedNames(request.runId);
    const [commitSha, image, migrationEvidence] = await Promise.all([
      this.readSingleLine('git', ['rev-parse', 'HEAD'], repository),
      this.inspectImage(),
      readNf04MigrationEvidence(join(repository, 'database/migrations')),
    ]);
    const migrationHashes = migrationEvidence.map((entry) => entry.hash);
    if (!/^[a-f0-9]{40}$/.test(commitSha) || migrationHashes.length === 0) {
      throw new Nf04PreparationError('NF-04 repository evidence is incomplete');
    }
    await assertLoopbackPortsAvailable([
      request.sourceDatabasePort,
      request.restoreDatabasePort,
      request.isolatedApiPort,
    ]);

    const handoffRoot = resolve(dirname(repository), 'handoff');
    const runsRoot = resolve(handoffRoot, NF04_ARTIFACT_ROOT_NAME);
    const artifactRoot = resolve(runsRoot, request.runId);
    const archivesRoot = resolve(artifactRoot, 'archives');
    const secretsRoot = resolve(artifactRoot, 'secrets');
    const runtimeRoot = resolve(artifactRoot, 'runtime');
    await assertRealDirectory(handoffRoot);
    await assertNf04FreeSpace(handoffRoot, this.availableBytes);
    await mkdir(runsRoot, { recursive: false }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    await assertRealDirectory(runsRoot);
    try {
      await mkdir(artifactRoot, { recursive: false, mode: 0o700 });
      await Promise.all([
        mkdir(archivesRoot, { recursive: false, mode: 0o700 }),
        mkdir(secretsRoot, { recursive: false, mode: 0o700 }),
        mkdir(runtimeRoot, { recursive: false, mode: 0o700 }),
      ]);
      await this.protectRunDirectory(artifactRoot);
    } catch {
      throw new Nf04PreparationError('NF-04 protected run directory could not be created');
    }

    const sourceManagerPassword = syntheticSecret('source-manager');
    const restoreManagerPassword = syntheticSecret('restore-manager');
    const sourceRolePassword = syntheticSecret('source-role');
    const restoreRolePassword = syntheticSecret('restore-role');
    const userPassword = syntheticSecret('user');
    const staffPassword = syntheticSecret('staff');
    const sourceDatabaseUrl = postgresUrl(
      names.sourceRole,
      sourceRolePassword,
      request.sourceDatabasePort,
      names.sourceDatabase,
    );
    const files = {
      fixtureSecrets: join(secretsRoot, 'fixture-secrets.json'),
      sourcePgPass: join(secretsRoot, 'source.pgpass'),
      restorePgPass: join(secretsRoot, 'restore.pgpass'),
      sourceManagerPassword: join(secretsRoot, 'source-manager-password'),
      restoreManagerPassword: join(secretsRoot, 'restore-manager-password'),
      executionSecrets: join(secretsRoot, 'execution-secrets.json'),
      isolatedApiEnvironment: join(secretsRoot, 'isolated-api.env'),
    } as const;

    const fixtureSecrets = nf04FixtureSecretsSchema.parse({
      databaseUrl: sourceDatabaseUrl,
      userEmail: `nf04-${request.runId}@example.test`,
      userPassword,
      sessionToken: `nf04-synthetic-${randomBytes(32).toString('base64url')}`,
      staffEmail: `nf04-staff-${request.runId}@example.test`,
      staffPassword,
    });
    const executionSecrets = nf04ExecutionSecretsSchema.parse({
      sourceRolePassword,
      restoreRolePassword,
    });
    try {
      await Promise.all([
        writeProtected(files.fixtureSecrets, `${JSON.stringify(fixtureSecrets)}\n`),
        writeProtected(files.executionSecrets, `${JSON.stringify(executionSecrets)}\n`),
        writeProtected(files.sourceManagerPassword, `${sourceManagerPassword}\n`),
        writeProtected(files.restoreManagerPassword, `${restoreManagerPassword}\n`),
        writeProtected(
          files.sourcePgPass,
          [
            `/var/run/postgresql:5432:${names.sourceDatabase}:${names.sourceRole}:${sourceRolePassword}`,
            `127.0.0.1:${request.sourceDatabasePort}:*:${names.sourceManagerRole}:${sourceManagerPassword}`,
            `127.0.0.1:${request.sourceDatabasePort}:${names.sourceDatabase}:${names.sourceRole}:${sourceRolePassword}`,
          ].join('\n') + '\n',
        ),
        writeProtected(
          files.restorePgPass,
          [
            `/var/run/postgresql:5432:${names.preRestoreDatabase}:${names.restoreRole}:${restoreRolePassword}`,
            `/var/run/postgresql:5432:${names.postRestoreDatabase}:${names.restoreRole}:${restoreRolePassword}`,
            `127.0.0.1:${request.restoreDatabasePort}:*:${names.restoreManagerRole}:${restoreManagerPassword}`,
            `127.0.0.1:${request.restoreDatabasePort}:*:${names.restoreRole}:${restoreRolePassword}`,
          ].join('\n') + '\n',
        ),
        writeProtected(
          files.isolatedApiEnvironment,
          isolatedApiEnvironment({
            apiPort: request.isolatedApiPort,
            databaseUrl: sourceDatabaseUrl,
          }),
        ),
      ]);
    } catch {
      throw new Nf04PreparationError('NF-04 protected run files could not be created');
    }

    const manifest = nf04ManifestSchema.parse({
      version: NF04_MANIFEST_VERSION,
      runId: request.runId,
      state: 'planned',
      repositoryRoot: repository,
      artifactRoot,
      archivesRoot,
      repository: {
        commitSha,
        migrationHashes: [...migrationHashes],
        migrationCreatedAt: migrationEvidence.map((entry) => entry.createdAt),
      },
      image,
      ports: {
        sourceDatabase: request.sourceDatabasePort,
        restoreDatabase: request.restoreDatabasePort,
        isolatedApi: request.isolatedApiPort,
      },
      files,
      observed: {},
      archives: {},
    } satisfies Nf04Manifest);
    const manifestPath = join(artifactRoot, 'manifest.json');
    await new Nf04ManifestStore(manifestPath, repository).create(manifest);
    return { manifestPath, runId: request.runId };
  }

  private async inspectImage(): Promise<Nf04Manifest['image']> {
    const output = await this.readSingleLine('docker', [
      'image',
      'inspect',
      NF04_POSTGRES_IMAGE,
      '--format',
      '{{json .}}',
    ]);
    let inspected: { Id?: unknown; RepoDigests?: unknown };
    try {
      inspected = JSON.parse(output) as { Id?: unknown; RepoDigests?: unknown };
    } catch {
      throw new Nf04PreparationError('NF-04 approved image evidence is unreadable');
    }
    if (typeof inspected.Id !== 'string') {
      throw new Nf04PreparationError('NF-04 approved image is not available locally');
    }
    const digest = Array.isArray(inspected.RepoDigests)
      ? inspected.RepoDigests.find((value): value is string => typeof value === 'string')
      : undefined;
    return {
      reference: NF04_POSTGRES_IMAGE,
      expectedImageId: inspected.Id,
      ...(digest ? { repositoryDigest: digest } : {}),
    };
  }

  private async protectRunDirectory(artifactRoot: string): Promise<void> {
    const identity = await this.readSingleLine('whoami', ['/user', '/fo', 'csv', '/nh']);
    const match = identity.match(/"(S-1-[0-9-]+)"\s*$/);
    if (!match?.[1]) throw new Nf04PreparationError('NF-04 operator identity is unavailable');
    const result = await this.runner.run({
      executable: 'icacls',
      args: [
        artifactRoot,
        '/inheritance:r',
        '/grant:r',
        `*${match[1]}:(OI)(CI)F`,
        '/grant:r',
        '*S-1-5-18:(OI)(CI)F',
        '/T',
        '/C',
      ],
      timeoutMs: 10_000,
    });
    if (result.timedOut || result.exitCode !== 0) {
      throw new Nf04PreparationError('NF-04 run directory ACL could not be protected');
    }
  }

  private async readSingleLine(
    executable: string,
    args: readonly string[],
    workingDirectory?: string,
  ): Promise<string> {
    const result = await this.runner.run({
      executable,
      args,
      timeoutMs: 10_000,
      ...(workingDirectory ? { workingDirectory } : {}),
    });
    if (result.timedOut || result.exitCode !== 0) {
      throw new Nf04PreparationError('NF-04 prerequisite command failed');
    }
    const line = result.stdout.trim();
    if (!line || line.includes('\n') || line.includes('\r')) {
      throw new Nf04PreparationError('NF-04 prerequisite evidence is malformed');
    }
    return line;
  }
}

function syntheticSecret(purpose: string): string {
  return `Synthetic-${purpose}-${randomBytes(32).toString('base64url')}`;
}

function postgresUrl(role: string, password: string, port: number, database: string): string {
  return `postgresql://${encodeURIComponent(role)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${encodeURIComponent(database)}`;
}

function isolatedApiEnvironment(input: { apiPort: number; databaseUrl: string }): string {
  return `${[
    'APP_ENV=test',
    `APP_PORT=${input.apiPort}`,
    `DATABASE_URL=${input.databaseUrl}`,
    'DATABASE_CONNECTION_TIMEOUT_MS=5000',
    'DATABASE_QUERY_TIMEOUT_MS=10000',
    'LOG_LEVEL=silent',
    `WEB_ORIGINS=http://127.0.0.1:${input.apiPort}`,
    'ADMIN_AUTH_ENABLED=false',
    'ACCOUNT_DELETION_ENABLED=true',
    'NF04_ISOLATED_API=true',
    'AGE_VERIFICATION_PROVIDER=mock',
    'FREE_DAILY_AI_LIMIT=20',
    'QUOTA_TIME_ZONE=Asia/Shanghai',
    'AI_CHAT_ENABLED=false',
    'AI_KNOWLEDGE_ENABLED=false',
    'AI_KNOWLEDGE_SYNTHETIC_FIXTURES_ENABLED=false',
    'LLM_PROVIDER=none',
    'AUDIT_RETENTION_DAYS=180',
  ].join('\n')}\n`;
}

async function writeProtected(path: string, content: string): Promise<void> {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertRealDirectory(path: string): Promise<void> {
  const [stats, resolved] = await Promise.all([lstat(path, { bigint: true }), realpath(path)]);
  const canonicalResolved = resolve(resolved).toLowerCase();
  const canonicalRequested = resolve(path).toLowerCase();
  if (!stats.isDirectory() || stats.isSymbolicLink() || canonicalResolved !== canonicalRequested) {
    throw new Nf04GuardError('NF-04 preparation parent is not a real directory');
  }
}

export async function assertLoopbackPortsAvailable(ports: readonly number[]): Promise<void> {
  for (const port of ports) {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const server = createServer();
      const finish = (error?: Error) => {
        server.removeAllListeners();
        if (error) rejectPromise(new Nf04PreparationError('NF-04 loopback port is unavailable'));
        else resolvePromise();
      };
      server.once('error', (error) => finish(error));
      server.listen({ host: '127.0.0.1', port, exclusive: true }, () =>
        server.close((error) => finish(error ?? undefined)),
      );
    });
  }
}
