import type { Stats } from 'node:fs';
import {
  access,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  truncate,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Nf04ArchiveManager,
  PollingNf04ArchiveWriterMonitor,
  assertNf04ArchivePathAbsent,
  type Nf04ArchivePublicationPort,
} from '../src/nf04/nf04-archive';
import type {
  Nf04ContainerExecExit,
  Nf04ContainerExecSpec,
  Nf04ContainerExecution,
  Nf04ContainerExecutionPort,
} from '../src/nf04/nf04-container-execution';
import { NF04_TOTAL_ARCHIVE_LIMIT_BYTES } from '../src/nf04/nf04-contract';
import type {
  Nf04ProcessResult,
  Nf04ProcessRunner,
  Nf04ProcessSpec,
  Nf04RunningProcess,
} from '../src/nf04/nf04-process';

class ArchiveRunner implements Nf04ProcessRunner, Nf04ContainerExecutionPort {
  readonly calls: Nf04ProcessSpec[] = [];
  readonly writerCalls: Nf04ContainerExecSpec[] = [];

  constructor(
    private readonly artifactRoot: string,
    private readonly archiveBytes = Buffer.from('synthetic-custom-archive'),
  ) {}

  async run(spec: Nf04ProcessSpec): Promise<Nf04ProcessResult> {
    this.calls.push(spec);
    return successfulResult();
  }

  start(): Nf04RunningProcess {
    throw new Error('not used');
  }

  async create(spec: Nf04ContainerExecSpec): Promise<Nf04ContainerExecution> {
    this.writerCalls.push(spec);
    const output = spec.args.at(-1);
    if (!output) throw new Error('missing output');
    return {
      identity: { containerId: spec.containerId, execId: 'exact-dump-exec-id' },
      localPid: 4101,
      start: async (signal) => {
        signal?.throwIfAborted();
        await writeFile(join(this.artifactRoot, output.split('/').at(-1)!), this.archiveBytes);
      },
      stop: async () => undefined,
      waitForExit: async () => successfulExit(),
    };
  }
}

class ControlledArchiveRunner implements Nf04ProcessRunner, Nf04ContainerExecutionPort {
  readonly calls: Nf04ProcessSpec[] = [];
  readonly writerCalls: Nf04ContainerExecSpec[] = [];
  readonly startCompletion = deferred<void>();
  readonly exitCompletion = deferred<Nf04ContainerExecExit>();
  stopCalls = 0;

  constructor(
    private readonly artifactRoot: string,
    private readonly settleOnStop: boolean,
  ) {}

  async run(spec: Nf04ProcessSpec): Promise<Nf04ProcessResult> {
    this.calls.push(spec);
    return successfulResult();
  }

  start(): Nf04RunningProcess {
    throw new Error('not used');
  }

  create(spec: Nf04ContainerExecSpec): Promise<Nf04ContainerExecution> {
    this.writerCalls.push(spec);
    const output = spec.args.at(-1);
    if (!output) throw new Error('missing output');
    const partialPath = join(this.artifactRoot, output.split('/').at(-1)!);
    const execution: Nf04ContainerExecution = {
      identity: { containerId: spec.containerId, execId: 'controlled-dump-exec-id' },
      localPid: 4102,
      start: async (signal) => {
        signal?.throwIfAborted();
        await writeFile(partialPath, '');
        await truncate(partialPath, NF04_TOTAL_ARCHIVE_LIMIT_BYTES + 1);
        await observeWithSignal(this.startCompletion.promise, signal);
      },
      stop: async (signal) => {
        signal?.throwIfAborted();
        this.stopCalls += 1;
        this.startCompletion.resolve(undefined);
        if (this.settleOnStop) this.exitCompletion.resolve(successfulExit());
      },
      waitForExit: (signal) => observeWithSignal(this.exitCompletion.promise, signal),
    };
    return Promise.resolve(execution);
  }
}

/** Test-only adapter. It operates only in each test's generated task directory. */
class TaskTempArchivePublicationPort implements Nf04ArchivePublicationPort {
  async publish(input: Parameters<Nf04ArchivePublicationPort['publish']>[0]): Promise<void> {
    input.signal.throwIfAborted();
    const [root, parent, partial] = await Promise.all([
      lstat(input.artifactRoot, { bigint: true }),
      lstat(input.artifactRoot, { bigint: true }),
      lstat(input.partialPath, { bigint: true }),
    ]);
    if (
      root.dev !== input.rootIdentity.device ||
      root.ino !== input.rootIdentity.inode ||
      parent.dev !== input.parentIdentity.device ||
      parent.ino !== input.parentIdentity.inode ||
      partial.dev !== input.partialIdentity.device ||
      partial.ino !== input.partialIdentity.inode
    ) {
      throw new Error('synthetic publication boundary changed');
    }
    input.signal.throwIfAborted();
    await link(input.partialPath, input.finalPath);
    await unlink(input.partialPath);
  }
}

function successfulResult(): Nf04ProcessResult {
  return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false };
}

function successfulExit(): Nf04ContainerExecExit {
  return { exitCode: 0 };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
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
  if (signal.aborted) return Promise.reject(new Error('synthetic abort'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new Error('synthetic abort'));
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

describe('NF-04 archive handoff', () => {
  const runId = '20260913-143000-a1b2c3d4';
  let temporaryRoot: string;
  let repositoryRoot: string;
  let root: string;
  let publicationPort: Nf04ArchivePublicationPort;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'mh-nf04-archive-'));
    repositoryRoot = join(temporaryRoot, 'mental-health-ai');
    root = join(temporaryRoot, 'handoff', 'nf04-backup-restore', runId);
    await Promise.all([mkdir(repositoryRoot), mkdir(root, { recursive: true })]);
    publicationPort = new TaskTempArchivePublicationPort();
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('uses fixed structured pg_dump/list arguments and publishes with no overwrite', async () => {
    const runner = new ArchiveRunner(root);
    const manager = new Nf04ArchiveManager(
      runner,
      runner,
      publicationPort,
      () => new Date('2026-09-13T03:00:00Z'),
    );
    const evidence = await manager.create({
      kind: 'pre-delete',
      repositoryRoot,
      artifactRoot: root,
      runId,
      sourceContainerId: 'exact-container-id',
      sourceRole: 'exact_source_role',
      sourceDatabase: 'exact_source_test',
      pgPassContainerPath: '/run/secrets/source.pgpass',
      timeoutMs: 120_000,
    });
    expect(evidence).toEqual({
      fileName: 'pre-delete.dump',
      byteSize: Buffer.byteLength('synthetic-custom-archive'),
      sha256: '0c3f73c552623a5086a69e060365bf921bc34e2161c13e91c1bc6ca0b42729cf',
      completedAt: '2026-09-13T03:00:00.000Z',
      listedWithPgRestore: true,
    });
    expect(runner.writerCalls[0]).toEqual(
      expect.objectContaining({
        containerId: 'exact-container-id',
        executable: 'pg_dump',
        environment: { PGPASSFILE: '/run/secrets/source.pgpass' },
      }),
    );
    expect(runner.writerCalls[0]?.args).toEqual(
      expect.arrayContaining(['-Fc', '--no-owner', '--no-privileges', '--lock-wait-timeout=5s']),
    );
    expect(runner.calls[0]?.executable).toBe('docker');
    expect(runner.calls[0]?.args).toEqual(
      expect.arrayContaining(['pg_restore', '--list', '/nf04-output/.pre-delete.dump.partial']),
    );
    expect(await readFile(join(root, 'pre-delete.dump'), 'utf8')).toBe('synthetic-custom-archive');
    await expect(
      manager.create({
        kind: 'pre-delete',
        repositoryRoot,
        artifactRoot: root,
        runId,
        sourceContainerId: 'exact-container-id',
        sourceRole: 'exact_source_role',
        sourceDatabase: 'exact_source_test',
        pgPassContainerPath: '/run/secrets/source.pgpass',
        timeoutMs: 120_000,
      }),
    ).rejects.toThrow(/already exist/i);
  });

  it('rejects altered archive evidence before restore can begin', async () => {
    const runner = new ArchiveRunner(root);
    const manager = new Nf04ArchiveManager(runner, runner, publicationPort);
    const evidence = await manager.create({
      kind: 'pre-delete',
      repositoryRoot,
      artifactRoot: root,
      runId,
      sourceContainerId: 'exact-container-id',
      sourceRole: 'exact_source_role',
      sourceDatabase: 'exact_source_test',
      pgPassContainerPath: '/run/secrets/source.pgpass',
      timeoutMs: 120_000,
    });
    await writeFile(join(root, evidence.fileName), 'tampered');
    await expect(
      manager.verify({ repositoryRoot, artifactRoot: root, runId, evidence }),
    ).rejects.toThrow(/size|digest/i);
  });

  it('requires verified pre-delete evidence before creating the second bounded archive', async () => {
    const runner = new ArchiveRunner(root);
    const manager = new Nf04ArchiveManager(runner, runner, publicationPort);
    await expect(
      manager.create({
        kind: 'post-delete',
        repositoryRoot,
        artifactRoot: root,
        runId,
        sourceContainerId: 'exact-container-id',
        sourceRole: 'exact_source_role',
        sourceDatabase: 'exact_source_test',
        pgPassContainerPath: '/run/secrets/source.pgpass',
        timeoutMs: 120_000,
      }),
    ).rejects.toThrow(/requires fixed pre-delete evidence/i);

    const preDelete = await manager.create({
      kind: 'pre-delete',
      repositoryRoot,
      artifactRoot: root,
      runId,
      sourceContainerId: 'exact-container-id',
      sourceRole: 'exact_source_role',
      sourceDatabase: 'exact_source_test',
      pgPassContainerPath: '/run/secrets/source.pgpass',
      timeoutMs: 120_000,
    });
    const postDelete = await manager.create({
      kind: 'post-delete',
      repositoryRoot,
      artifactRoot: root,
      runId,
      sourceContainerId: 'exact-container-id',
      sourceRole: 'exact_source_role',
      sourceDatabase: 'exact_source_test',
      pgPassContainerPath: '/run/secrets/source.pgpass',
      timeoutMs: 120_000,
      priorArchive: preDelete,
    });
    expect(postDelete.fileName).toBe('post-delete.dump');
  });

  it('monitors the remaining capacity, stops the writer, and never lists or publishes overflow', async () => {
    const runner = new ControlledArchiveRunner(root, true);
    const manager = new Nf04ArchiveManager(
      runner,
      runner,
      publicationPort,
      undefined,
      new PollingNf04ArchiveWriterMonitor(1, 50),
    );

    await expect(
      manager.create({
        kind: 'pre-delete',
        repositoryRoot,
        artifactRoot: root,
        runId,
        sourceContainerId: 'exact-container-id',
        sourceRole: 'exact_source_role',
        sourceDatabase: 'exact_source_test',
        pgPassContainerPath: '/run/secrets/source.pgpass',
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/remaining capacity/i);

    expect(runner.stopCalls).toBe(1);
    expect(runner.writerCalls).toHaveLength(1);
    expect(runner.writerCalls[0]?.executable).toBe('pg_dump');
    expect(runner.calls).toHaveLength(0);
    expect((await stat(join(root, '.pre-delete.dump.partial'))).size).toBe(
      NF04_TOTAL_ARCHIVE_LIMIT_BYTES + 1,
    );
    await expect(access(join(root, 'pre-delete.dump'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps an unconfirmed writer partial isolated and ignores a late successful completion', async () => {
    const runner = new ControlledArchiveRunner(root, false);
    const manager = new Nf04ArchiveManager(
      runner,
      runner,
      publicationPort,
      undefined,
      new PollingNf04ArchiveWriterMonitor(1, 10),
    );

    await expect(
      manager.create({
        kind: 'pre-delete',
        repositoryRoot,
        artifactRoot: root,
        runId,
        sourceContainerId: 'exact-container-id',
        sourceRole: 'exact_source_role',
        sourceDatabase: 'exact_source_test',
        pgPassContainerPath: '/run/secrets/source.pgpass',
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/exit could not be confirmed/i);

    runner.exitCompletion.resolve(successfulExit());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runner.stopCalls).toBe(1);
    expect(runner.writerCalls).toHaveLength(1);
    expect(runner.calls).toHaveLength(0);
    expect(await stat(join(root, '.pre-delete.dump.partial'))).toEqual(
      expect.objectContaining({ size: NF04_TOTAL_ARCHIVE_LIMIT_BYTES + 1 }),
    );
    await expect(access(join(root, 'pre-delete.dump'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    { label: 'operation deadline', expired: true, settle: 'resolve' as const },
    { label: 'caller cancellation', expired: false, settle: 'reject' as const },
  ])(
    'stops the exact writer when partial inspection hangs through $label and ignores its late result',
    async ({ expired, settle }) => {
      const runner = new ControlledArchiveRunner(root, true);
      const execution = await runner.create({
        containerId: 'exact-container-id',
        executable: 'pg_dump',
        args: ['/nf04-output/.pre-delete.dump.partial'],
      });
      const inspectionStarted = deferred<void>();
      const lateInspection = deferred<Stats>();
      const monitor = new PollingNf04ArchiveWriterMonitor(1, 50, async () => {
        inspectionStarted.resolve(undefined);
        return lateInspection.promise;
      });
      const controller = new AbortController();
      const pending = monitor.waitForCompletion({
        execution,
        identity: execution.identity,
        partialPath: join(root, '.pre-delete.dump.partial'),
        maximumBytes: NF04_TOTAL_ARCHIVE_LIMIT_BYTES,
        operationSignal: controller.signal,
        deadlineExpired: () => expired,
      });
      await inspectionStarted.promise;

      controller.abort(new Error('synthetic stop'));
      await expect(pending).rejects.toThrow(expired ? /deadline/i : /cancelled/i);
      expect(runner.stopCalls).toBe(1);
      expect(runner.calls).toHaveLength(0);
      await expect(access(join(root, 'pre-delete.dump'))).rejects.toMatchObject({ code: 'ENOENT' });

      if (settle === 'resolve') {
        lateInspection.resolve(await stat(join(root, '.pre-delete.dump.partial')));
      } else {
        lateInspection.reject(new Error('late synthetic inspection failure'));
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(runner.stopCalls).toBe(1);
      expect(runner.calls).toHaveLength(0);
    },
  );

  it('does not treat a non-ENOENT absence probe failure as an absent output path', async () => {
    const accessFailure = Object.assign(new Error('synthetic secret path'), { code: 'EACCES' });
    await expect(
      assertNf04ArchivePathAbsent(join(root, 'candidate.dump'), () =>
        Promise.reject(accessFailure),
      ),
    ).rejects.toThrow(/availability could not be confirmed/i);
  });

  it('continues only for an explicit ENOENT absence result', async () => {
    const missing = Object.assign(new Error('synthetic missing'), { code: 'ENOENT' });
    await expect(
      assertNf04ArchivePathAbsent(join(root, 'candidate.dump'), () => Promise.reject(missing)),
    ).resolves.toBeUndefined();
  });

  it('does not publish when cancellation arrives while the archive listing is in flight', async () => {
    const controller = new AbortController();
    const runner = new ArchiveRunner(root);
    const originalRun = runner.run.bind(runner);
    jest.spyOn(runner, 'run').mockImplementationOnce(async (spec) => {
      controller.abort();
      return originalRun(spec);
    });
    const manager = new Nf04ArchiveManager(runner, runner, publicationPort);

    await expect(
      manager.create({
        kind: 'pre-delete',
        repositoryRoot,
        artifactRoot: root,
        runId,
        sourceContainerId: 'exact-container-id',
        sourceRole: 'exact_source_role',
        sourceDatabase: 'exact_source_test',
        pgPassContainerPath: '/run/secrets/source.pgpass',
        timeoutMs: 120_000,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/i);

    await expect(access(join(root, 'pre-delete.dump'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(root, '.pre-delete.dump.partial'), 'utf8')).toBe(
      'synthetic-custom-archive',
    );
  });

  it('does not publish when the archive content changes during listing', async () => {
    const runner = new ArchiveRunner(root);
    const originalRun = runner.run.bind(runner);
    jest.spyOn(runner, 'run').mockImplementationOnce(async (spec) => {
      await writeFile(join(root, '.pre-delete.dump.partial'), 'changed-after-listing-start');
      return originalRun(spec);
    });
    const manager = new Nf04ArchiveManager(runner, runner, publicationPort);

    await expect(
      manager.create({
        kind: 'pre-delete',
        repositoryRoot,
        artifactRoot: root,
        runId,
        sourceContainerId: 'exact-container-id',
        sourceRole: 'exact_source_role',
        sourceDatabase: 'exact_source_test',
        pgPassContainerPath: '/run/secrets/source.pgpass',
        timeoutMs: 120_000,
      }),
    ).rejects.toThrow(/changed during table-of-contents/i);

    await expect(access(join(root, 'pre-delete.dump'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects publication when the verified artifact directory is replaced during listing', async () => {
    const movedRoot = `${root}-replaced`;
    const runner = new ArchiveRunner(root);
    const originalRun = runner.run.bind(runner);
    jest.spyOn(runner, 'run').mockImplementationOnce(async (spec) => {
      await rename(root, movedRoot);
      await mkdir(root);
      return originalRun(spec);
    });
    const manager = new Nf04ArchiveManager(runner, runner, publicationPort);

    try {
      await expect(
        manager.create({
          kind: 'pre-delete',
          repositoryRoot,
          artifactRoot: root,
          runId,
          sourceContainerId: 'exact-container-id',
          sourceRole: 'exact_source_role',
          sourceDatabase: 'exact_source_test',
          pgPassContainerPath: '/run/secrets/source.pgpass',
          timeoutMs: 120_000,
        }),
      ).rejects.toThrow(/boundary changed|protected file does not exist/i);
      await expect(access(join(root, 'pre-delete.dump'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(movedRoot, '.pre-delete.dump.partial'), 'utf8')).toBe(
        'synthetic-custom-archive',
      );
    } finally {
      await rm(movedRoot, { recursive: true, force: true });
    }
  });
});
