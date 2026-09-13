import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import type { Nf04ArchivePublicationPort } from '../src/nf04/nf04-archive';
import type { Nf04ContainerExecutionPort } from '../src/nf04/nf04-container-execution';
import {
  deriveNf04ExpectedNames,
  NF04_POSTGRES_IMAGE,
  nf04ExecutableManifestSchema,
  type Nf04ExecutableManifest,
} from '../src/nf04/nf04-contract';
import { assertLiveNf04DockerEvidence, Nf04DockerInspector } from '../src/nf04/nf04-docker';
import { matchesNf04DockerBindSource } from '../src/nf04/nf04-guards';
import { SystemNf04RealActionRuntime } from '../src/nf04/nf04-real-actions';
import {
  NodeNf04ProcessRunner,
  type Nf04ProcessResult,
  type Nf04ProcessRunner,
  type Nf04ProcessSpec,
  type Nf04RunningProcess,
} from '../src/nf04/nf04-process';
import type { Nf04StableFileCleanupPort } from '../src/nf04/nf04-windows-file-operations';

const ENABLED = process.platform === 'win32' && process.env.NF04_DOCKER_RESOURCE_TEST === 'true';
const describeDocker = ENABLED ? describe : describe.skip;
const repositoryRoot = resolve(process.cwd(), '../..');
const artifactParent = resolve(dirname(repositoryRoot), 'handoff', 'nf04-backup-restore');

type DockerFixture = Readonly<{
  runId: string;
  artifactRoot: string;
  manifest: Nf04ExecutableManifest;
  runner: ControlledContainerRunner;
}>;

describeDocker('NF-04 real Docker resource stages (opt-in)', () => {
  let fixture: DockerFixture | undefined;

  afterEach(async () => {
    if (!fixture) return;
    await cleanupExactDockerResources(fixture.runner.actual, fixture.manifest);
    await cleanupExactArtifactRoot(fixture.artifactRoot, fixture.runId);
    fixture = undefined;
  }, 60_000);

  it('uses configured evidence before start and runtime evidence only while running', async () => {
    fixture = await createDockerFixture(false);
    const runtime = createRuntime(fixture.runner);
    const partialKeys: string[] = [];
    const partial: Record<string, unknown> = {};

    const resources = await runtime.createResources(fixture.manifest, async (evidence) => {
      Object.assign(partial, evidence);
      partialKeys.push(...Object.keys(evidence));
    });

    expect(partialKeys).toEqual([
      'network',
      'sourceVolume',
      'restoreVolume',
      'sourceContainer',
      'restoreContainer',
    ]);
    expect(partial.sourceContainer).toMatchObject({ id: resources.sourceContainer.id });
    expect(partial.restoreContainer).toMatchObject({ id: resources.restoreContainer.id });

    const sourceArtifactMount = resources.sourceContainer.mounts.find(
      (mount) => mount.destination === '/nf04-output',
    );
    const sourceSecretMount = resources.sourceContainer.mounts.find(
      (mount) => mount.destination === '/run/secrets/nf04-source.pgpass',
    );
    expect(sourceArtifactMount?.source).toMatch(/^\/run\/desktop\/mnt\/host\/[a-z]\//u);
    expect(sourceSecretMount?.source).toMatch(/^\/run\/desktop\/mnt\/host\/[a-z]\//u);
    expect(
      matchesNf04DockerBindSource(fixture.manifest.archivesRoot, sourceArtifactMount!.source),
    ).toBe(true);
    expect(
      matchesNf04DockerBindSource(fixture.manifest.files.sourcePgPass, sourceSecretMount!.source),
    ).toBe(true);

    const withEvidence = nf04ExecutableManifestSchema.parse({
      ...fixture.manifest,
      observed: resources,
    });
    const inspector = new Nf04DockerInspector(fixture.runner.actual);
    await expect(
      inspector.inspectRecorded(withEvidence, 'source', undefined, 'running'),
    ).resolves.toMatchObject({ container: { hostPort: fixture.manifest.ports.sourceDatabase } });
    await expect(
      inspector.inspectRecorded(withEvidence, 'restore', undefined, 'running'),
    ).resolves.toMatchObject({ container: { hostPort: fixture.manifest.ports.restoreDatabase } });

    await expectShellEntrypoint(fixture.runner.actual, resources.sourceContainer.id);
    await runDocker(fixture.runner.actual, ['stop', '--time', '5', resources.sourceContainer.id]);
    const stopped = await inspector.inspectRecorded(withEvidence, 'source', undefined, 'stopped');
    expect(stopped).toMatchObject({
      container: { hostPort: fixture.manifest.ports.sourceDatabase },
    });
    expect(() =>
      assertLiveNf04DockerEvidence(
        {
          container: resources.sourceContainer,
          volume: resources.sourceVolume,
          network: resources.network,
        },
        stopped,
      ),
    ).not.toThrow();
    await expect(
      inspector.inspectRecorded(withEvidence, 'source', undefined, 'running'),
    ).rejects.toThrow(/running state/i);
  }, 90_000);

  it('records the exact created container ID before a configured-port guard failure', async () => {
    fixture = await createDockerFixture(true);
    const runtime = createRuntime(fixture.runner);
    const partial: Record<string, unknown> = {};

    await expect(
      runtime.createResources(fixture.manifest, async (evidence) => {
        Object.assign(partial, evidence);
      }),
    ).rejects.toThrow(/identity/i);

    const recorded = partial.sourceContainer as { id?: string; hostPort?: number } | undefined;
    expect(recorded?.id).toMatch(/^[a-f0-9]{64}$/u);
    expect(recorded?.hostPort).toBe(fixture.manifest.ports.sourceDatabase + 1);
    const actual = await inspectContainer(fixture.runner.actual, recorded!.id!);
    expect(actual.State).toMatchObject({ Status: 'created', Running: false, Pid: 0 });
    expect(actual.Config.Labels).toMatchObject({
      'mh.nf04.run': fixture.runId,
      'mh.nf04.role': 'source',
    });
  }, 60_000);
});

class ControlledContainerRunner implements Nf04ProcessRunner {
  readonly actual = new NodeNf04ProcessRunner();
  private tamperConfiguredSourceInspect: boolean;

  constructor(tamperConfiguredSourceInspect: boolean) {
    this.tamperConfiguredSourceInspect = tamperConfiguredSourceInspect;
  }

  async run(spec: Nf04ProcessSpec): Promise<Nf04ProcessResult> {
    const result = await this.actual.run(transformPostgresCreate(spec));
    if (
      this.tamperConfiguredSourceInspect &&
      spec.executable === 'docker' &&
      spec.args[0] === 'container' &&
      spec.args[1] === 'inspect' &&
      result.exitCode === 0
    ) {
      const records = JSON.parse(result.stdout) as Array<{
        State: { Status: string };
        Config: { Labels?: Record<string, string> | null };
        HostConfig: {
          PortBindings: Record<string, Array<{ HostIp: string; HostPort: string }> | null>;
        };
      }>;
      const record = records[0];
      if (
        record?.State.Status === 'created' &&
        record.Config.Labels?.['mh.nf04.role'] === 'source'
      ) {
        const binding = record.HostConfig.PortBindings['5432/tcp']?.[0];
        if (!binding) throw new Error('real configured source binding is missing');
        binding.HostPort = String(Number(binding.HostPort) + 1);
        this.tamperConfiguredSourceInspect = false;
        return { ...result, stdout: JSON.stringify(records) };
      }
    }
    return result;
  }

  start(spec: Nf04ProcessSpec): Nf04RunningProcess {
    return this.actual.start(transformPostgresCreate(spec));
  }
}

function transformPostgresCreate(spec: Nf04ProcessSpec): Nf04ProcessSpec {
  if (spec.executable !== 'docker' || spec.args[0] !== 'container' || spec.args[1] !== 'create') {
    return spec;
  }
  const imageIndex = spec.args.lastIndexOf(NF04_POSTGRES_IMAGE);
  if (imageIndex < 0 || imageIndex !== spec.args.length - 1) {
    throw new Error('NF-04 test could not locate the fixed image argument');
  }
  return {
    ...spec,
    args: [
      ...spec.args.slice(0, imageIndex),
      '--entrypoint',
      '/bin/sh',
      NF04_POSTGRES_IMAGE,
      '-c',
      'while :; do sleep 1; done',
    ],
  };
}

function createRuntime(runner: Nf04ProcessRunner): SystemNf04RealActionRuntime {
  return new SystemNf04RealActionRuntime({
    processRunner: runner,
    containerExecutionPort: rejectingExecutionPort(),
    archivePublicationPort: rejectingPublicationPort(),
    stableFileCleanupPort: rejectingCleanupPort(),
    apiEntryPoint: resolve(repositoryRoot, 'apps/api/dist/src/main.js'),
    operationTimeoutMs: 20_000,
    restoreTimeoutMs: 20_000,
    reconciliationTimeoutMs: 10_000,
    availableBytes: async () => 3n * 1024n * 1024n * 1024n,
  });
}

async function createDockerFixture(tamper: boolean): Promise<DockerFixture> {
  const now = new Date();
  const timestamp = now
    .toISOString()
    .replaceAll(/[-:TZ.]/gu, '')
    .slice(0, 14);
  const runId = `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-${randomBytes(4).toString('hex')}`;
  const artifactRoot = join(artifactParent, runId);
  const archivesRoot = join(artifactRoot, 'archives');
  const secretsRoot = join(artifactRoot, 'secrets');
  await mkdir(archivesRoot, { recursive: true });
  await mkdir(secretsRoot, { recursive: true });
  const files = {
    fixtureSecrets: join(secretsRoot, 'fixture-secrets.json'),
    sourcePgPass: join(secretsRoot, 'source.pgpass'),
    restorePgPass: join(secretsRoot, 'restore.pgpass'),
    sourceManagerPassword: join(secretsRoot, 'source-manager-password'),
    restoreManagerPassword: join(secretsRoot, 'restore-manager-password'),
    executionSecrets: join(secretsRoot, 'execution-secrets.json'),
    isolatedApiEnvironment: join(secretsRoot, 'isolated-api.env'),
  };
  await Promise.all(
    Object.values(files).map((path, index) =>
      writeFile(path, `Synthetic-NF04-resource-stage-${index}`, { mode: 0o600, flag: 'wx' }),
    ),
  );
  const ports = await allocateLoopbackPorts(3);
  const runner = new ControlledContainerRunner(tamper);
  const imageId = (
    await runDocker(runner.actual, ['image', 'inspect', '--format', '{{.Id}}', NF04_POSTGRES_IMAGE])
  ).trim();
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
    image: { reference: NF04_POSTGRES_IMAGE, expectedImageId: imageId },
    ports: {
      sourceDatabase: ports[0],
      restoreDatabase: ports[1],
      isolatedApi: ports[2],
    },
    files,
    observed: {},
    archives: {},
  });
  return { runId, artifactRoot, manifest, runner };
}

async function allocateLoopbackPorts(count: number): Promise<number[]> {
  const servers: Server[] = [];
  try {
    const ports: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const server = createServer();
      servers.push(server);
      await new Promise<void>((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolveListen());
      });
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('loopback port was not assigned');
      ports.push(address.port);
    }
    return ports;
  } finally {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          }),
      ),
    );
  }
}

async function expectShellEntrypoint(runner: Nf04ProcessRunner, id: string): Promise<void> {
  const record = await inspectContainer(runner, id);
  expect(record.Config.Entrypoint).toEqual(['/bin/sh']);
  const command = await runDocker(runner, [
    'exec',
    id,
    '/bin/sh',
    '-c',
    'test "$(cat /proc/1/comm)" = "sh"',
  ]);
  expect(command).toBe('');
}

type InspectedContainer = {
  Id: string;
  Name: string;
  State: { Status: string; Running: boolean; Pid: number };
  Config: { Entrypoint: string[] | null; Labels: Record<string, string> | null };
};

async function inspectContainer(
  runner: Nf04ProcessRunner,
  identity: string,
): Promise<InspectedContainer> {
  const output = await runDocker(runner, ['container', 'inspect', identity]);
  const records = JSON.parse(output) as InspectedContainer[];
  if (records.length !== 1) throw new Error('expected one exact test container');
  return records[0]!;
}

async function cleanupExactDockerResources(
  runner: Nf04ProcessRunner,
  manifest: Nf04ExecutableManifest,
): Promise<void> {
  const names = deriveNf04ExpectedNames(manifest.runId);
  for (const [name, role] of [
    [names.sourceContainer, 'source'],
    [names.restoreContainer, 'restore'],
  ] as const) {
    const inspected = await runDockerOptional(runner, ['container', 'inspect', name], 'container');
    if (!inspected) continue;
    const records = JSON.parse(inspected) as InspectedContainer[];
    const record = records[0];
    if (
      records.length !== 1 ||
      record?.Name !== `/${name}` ||
      record.Config.Labels?.['mh.nf04.run'] !== manifest.runId ||
      record.Config.Labels?.['mh.nf04.role'] !== role
    ) {
      throw new Error('refusing to clean a non-matching NF-04 test container');
    }
    if (record.State.Running) await runDocker(runner, ['stop', '--time', '5', record.Id]);
    const stopped = await inspectContainer(runner, record.Id);
    if (stopped.State.Running) throw new Error('test container stop was not confirmed');
    await runDocker(runner, ['container', 'rm', record.Id]);
    await expectDockerAbsent(runner, 'container', record.Id);
  }

  for (const [name, role] of [
    [names.sourceVolume, 'source'],
    [names.restoreVolume, 'restore'],
  ] as const) {
    const inspected = await runDockerOptional(runner, ['volume', 'inspect', name], 'volume');
    if (!inspected) continue;
    const records = JSON.parse(inspected) as Array<{
      Name: string;
      Driver: string;
      Labels: Record<string, string> | null;
    }>;
    const record = records[0];
    if (
      records.length !== 1 ||
      record?.Name !== name ||
      record.Driver !== 'local' ||
      record.Labels?.['mh.nf04.run'] !== manifest.runId ||
      record.Labels?.['mh.nf04.role'] !== role
    ) {
      throw new Error('refusing to clean a non-matching NF-04 test volume');
    }
    const users = await runDocker(runner, [
      'container',
      'ls',
      '--all',
      '--no-trunc',
      '--filter',
      `volume=${name}`,
      '--format',
      '{{.ID}}',
    ]);
    if (users.trim() !== '') throw new Error('test volume is still referenced');
    await runDocker(runner, ['volume', 'rm', name]);
    await expectDockerAbsent(runner, 'volume', name);
  }

  const networkRaw = await runDockerOptional(
    runner,
    ['network', 'inspect', names.network],
    'network',
  );
  if (networkRaw) {
    const records = JSON.parse(networkRaw) as Array<{
      Id: string;
      Name: string;
      Driver: string;
      Labels: Record<string, string> | null;
      Containers: Record<string, unknown> | null;
    }>;
    const record = records[0];
    if (
      records.length !== 1 ||
      record?.Name !== names.network ||
      record.Driver !== 'bridge' ||
      record.Labels?.['mh.nf04.run'] !== manifest.runId ||
      record.Labels?.['mh.nf04.role'] !== 'network' ||
      Object.keys(record.Containers ?? {}).length !== 0
    ) {
      throw new Error('refusing to clean a non-matching or non-empty NF-04 test network');
    }
    await runDocker(runner, ['network', 'rm', record.Id]);
    await expectDockerAbsent(runner, 'network', record.Id);
  }
}

async function runDocker(runner: Nf04ProcessRunner, args: string[]): Promise<string> {
  const result = await runner.run({ executable: 'docker', args, timeoutMs: 20_000 });
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error('exact NF-04 test Docker command failed');
  }
  return result.stdout.trim();
}

async function runDockerOptional(
  runner: Nf04ProcessRunner,
  args: string[],
  kind: 'container' | 'volume' | 'network',
): Promise<string | undefined> {
  const result = await runner.run({ executable: 'docker', args, timeoutMs: 20_000 });
  if (result.exitCode === 0 && !result.timedOut) return result.stdout;
  if (result.timedOut || !new RegExp(`no such ${kind}|not found`, 'iu').test(result.stderr)) {
    throw new Error('exact NF-04 test Docker absence could not be established');
  }
  return undefined;
}

async function expectDockerAbsent(
  runner: Nf04ProcessRunner,
  kind: 'container' | 'volume' | 'network',
  identity: string,
): Promise<void> {
  const result = await runner.run({
    executable: 'docker',
    args: [kind, 'inspect', identity],
    timeoutMs: 20_000,
  });
  expect(result.timedOut).toBe(false);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toMatch(new RegExp(`no such ${kind}|not found`, 'iu'));
}

async function cleanupExactArtifactRoot(artifactRoot: string, runId: string): Promise<void> {
  if (resolve(dirname(artifactRoot)) !== artifactParent || basename(artifactRoot) !== runId) {
    throw new Error('refusing to remove an unexpected NF-04 test artifact root');
  }
  await rm(artifactRoot, { recursive: true, force: true });
}

function rejectingExecutionPort(): Nf04ContainerExecutionPort {
  return {
    create: async () => {
      throw new Error('container execution must not be reached by resource-stage tests');
    },
  };
}

function rejectingPublicationPort(): Nf04ArchivePublicationPort {
  return {
    publish: async () => {
      throw new Error('archive publication must not be reached by resource-stage tests');
    },
  };
}

function rejectingCleanupPort(): Nf04StableFileCleanupPort {
  return {
    delete: async () => {
      throw new Error('stable file cleanup must not be reached by resource-stage tests');
    },
  };
}
