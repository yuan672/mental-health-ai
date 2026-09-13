import { randomUUID } from 'node:crypto';
import {
  DockerEngineNf04ContainerExecutionPort,
  WindowsNamedPipeNf04DockerEngineClient,
} from '../src/nf04/nf04-docker-engine-execution';
import { NodeNf04ProcessRunner } from '../src/nf04/nf04-process';

const ENABLED = process.platform === 'win32' && process.env.NF04_DOCKER_ADAPTER_TEST === 'true';
const describeDocker = ENABLED ? describe : describe.skip;

describeDocker('NF-04 Windows Docker Engine exec adapter (opt-in)', () => {
  const runner = new NodeNf04ProcessRunner();
  const runToken = randomUUID().replaceAll('-', '').slice(0, 12);
  const runId = `exec-adapter-${runToken}`;
  const containerName = `mh-nf04-${runToken}-exec-adapter-test`;
  let containerId: string | undefined;

  beforeAll(async () => {
    const created = await runner.run({
      executable: 'docker',
      args: [
        'container',
        'create',
        '--pull=never',
        '--name',
        containerName,
        '--label',
        `mh.nf04.run=${runId}`,
        '--label',
        'mh.nf04.role=exec-adapter-test',
        '--tmpfs',
        '/var/lib/postgresql',
        '--entrypoint',
        '/bin/sh',
        'postgres:18.6-alpine',
        '-c',
        'while :; do sleep 1; done',
      ],
      timeoutMs: 20_000,
    });
    expect(created.timedOut).toBe(false);
    expect(created.exitCode).toBe(0);
    containerId = created.stdout.trim();
    expect(containerId).toMatch(/^[a-f0-9]{64}$/);

    await assertExactTestContainer(runner, containerId!, runId, containerName);
    const started = await runner.run({
      executable: 'docker',
      args: ['container', 'start', containerId!],
      timeoutMs: 20_000,
    });
    expect(started.timedOut).toBe(false);
    expect(started.exitCode).toBe(0);
  }, 30_000);

  afterAll(async () => {
    if (!containerId) return;
    await assertExactTestContainer(runner, containerId, runId, containerName);
    const removed = await runner.run({
      executable: 'docker',
      args: ['container', 'rm', '--force', containerId],
      timeoutMs: 20_000,
    });
    expect(removed.timedOut).toBe(false);
    expect(removed.exitCode).toBe(0);
    const absent = await runner.run({
      executable: 'docker',
      args: ['container', 'inspect', containerId],
      timeoutMs: 10_000,
    });
    expect(absent.exitCode).not.toBe(0);
  }, 30_000);

  it('proves a short exit and stops a waiting child through their exact exec identities', async () => {
    const direct = await runner.run({
      executable: 'docker',
      args: ['exec', containerId!, '/bin/sh', '-c', 'exit 7'],
      timeoutMs: 10_000,
    });
    expect({ exitCode: direct.exitCode, stderr: direct.stderr }).toEqual({
      exitCode: 7,
      stderr: '',
    });

    const engine = new WindowsNamedPipeNf04DockerEngineClient();
    const port = new DockerEngineNf04ContainerExecutionPort(engine, 10_000, 25);
    const short = await port.create({
      containerId: containerId!,
      executable: '/bin/sh',
      args: ['-c', 'exit 7'],
    });
    await short.start(AbortSignal.timeout(10_000));
    await expect(short.waitForExit(AbortSignal.timeout(10_000))).resolves.toEqual({ exitCode: 7 });

    const execution = await port.create({
      containerId: containerId!,
      executable: '/bin/sh',
      args: ['-c', 'while :; do sleep 1; done'],
    });

    expect(execution.identity.containerId).toBe(containerId);
    expect(execution.identity.execId).toMatch(/^[a-f0-9]{64}$/);
    await execution.start(AbortSignal.timeout(10_000));
    await expect(
      engine.inspectExec(execution.identity.execId, AbortSignal.timeout(10_000)),
    ).resolves.toMatchObject({
      id: execution.identity.execId,
      containerId,
      running: true,
    });
    await execution.stop(AbortSignal.timeout(10_000));
    await expect(execution.waitForExit(AbortSignal.timeout(10_000))).resolves.toEqual({
      exitCode: expect.any(Number),
    });
  }, 30_000);
});

async function assertExactTestContainer(
  runner: NodeNf04ProcessRunner,
  containerId: string,
  runId: string,
  containerName: string,
): Promise<void> {
  const inspected = await runner.run({
    executable: 'docker',
    args: ['container', 'inspect', containerId],
    timeoutMs: 10_000,
  });
  expect(inspected.timedOut).toBe(false);
  expect(inspected.exitCode).toBe(0);
  const records = JSON.parse(inspected.stdout) as Array<{
    Id?: unknown;
    Name?: unknown;
    Config?: { Labels?: Record<string, string> | null };
  }>;
  expect(records).toHaveLength(1);
  expect(records[0]).toEqual(
    expect.objectContaining({
      Id: containerId,
      Name: `/${containerName}`,
      Config: expect.objectContaining({
        Labels: expect.objectContaining({
          'mh.nf04.run': runId,
          'mh.nf04.role': 'exec-adapter-test',
        }),
      }),
    }),
  );
}
