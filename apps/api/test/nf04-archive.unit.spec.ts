import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Nf04ArchiveManager } from '../src/nf04/nf04-archive';
import type {
  Nf04ProcessResult,
  Nf04ProcessRunner,
  Nf04ProcessSpec,
  Nf04RunningProcess,
} from '../src/nf04/nf04-process';

class ArchiveRunner implements Nf04ProcessRunner {
  readonly calls: Nf04ProcessSpec[] = [];

  constructor(
    private readonly artifactRoot: string,
    private readonly archiveBytes = Buffer.from('synthetic-custom-archive'),
  ) {}

  async run(spec: Nf04ProcessSpec): Promise<Nf04ProcessResult> {
    this.calls.push(spec);
    if (spec.args.includes('pg_dump')) {
      const output = spec.args.at(-1);
      if (!output) throw new Error('missing output');
      await writeFile(join(this.artifactRoot, output.split('/').at(-1)!), this.archiveBytes);
    }
    return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false };
  }

  start(): Nf04RunningProcess {
    throw new Error('not used');
  }
}

describe('NF-04 archive handoff', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mh-nf04-archive-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('uses fixed structured pg_dump/list arguments and publishes with no overwrite', async () => {
    const runner = new ArchiveRunner(root);
    const manager = new Nf04ArchiveManager(runner, () => new Date('2026-09-13T03:00:00Z'));
    const evidence = await manager.create({
      kind: 'pre-delete',
      artifactRoot: root,
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
    expect(runner.calls[0]?.executable).toBe('docker');
    expect(runner.calls[0]?.args).toEqual(
      expect.arrayContaining([
        'pg_dump',
        '-Fc',
        '--no-owner',
        '--no-privileges',
        '--lock-wait-timeout=5s',
      ]),
    );
    expect(runner.calls[1]?.args).toEqual(
      expect.arrayContaining(['pg_restore', '--list', '/nf04-output/.pre-delete.dump.partial']),
    );
    expect(await readFile(join(root, 'pre-delete.dump'), 'utf8')).toBe('synthetic-custom-archive');
    await expect(
      manager.create({
        kind: 'pre-delete',
        artifactRoot: root,
        sourceContainerId: 'exact-container-id',
        sourceRole: 'exact_source_role',
        sourceDatabase: 'exact_source_test',
        pgPassContainerPath: '/run/secrets/source.pgpass',
        timeoutMs: 120_000,
      }),
    ).rejects.toThrow(/already exists/i);
  });

  it('rejects altered archive evidence before restore can begin', async () => {
    const runner = new ArchiveRunner(root);
    const manager = new Nf04ArchiveManager(runner);
    const evidence = await manager.create({
      kind: 'pre-delete',
      artifactRoot: root,
      sourceContainerId: 'exact-container-id',
      sourceRole: 'exact_source_role',
      sourceDatabase: 'exact_source_test',
      pgPassContainerPath: '/run/secrets/source.pgpass',
      timeoutMs: 120_000,
    });
    await writeFile(join(root, evidence.fileName), 'tampered');
    await expect(manager.verify(root, evidence)).rejects.toThrow(/size|digest/i);
  });

  it('requires verified pre-delete evidence before creating the second bounded archive', async () => {
    const runner = new ArchiveRunner(root);
    const manager = new Nf04ArchiveManager(runner);
    await expect(
      manager.create({
        kind: 'post-delete',
        artifactRoot: root,
        sourceContainerId: 'exact-container-id',
        sourceRole: 'exact_source_role',
        sourceDatabase: 'exact_source_test',
        pgPassContainerPath: '/run/secrets/source.pgpass',
        timeoutMs: 120_000,
      }),
    ).rejects.toThrow(/requires fixed pre-delete evidence/i);

    const preDelete = await manager.create({
      kind: 'pre-delete',
      artifactRoot: root,
      sourceContainerId: 'exact-container-id',
      sourceRole: 'exact_source_role',
      sourceDatabase: 'exact_source_test',
      pgPassContainerPath: '/run/secrets/source.pgpass',
      timeoutMs: 120_000,
    });
    const postDelete = await manager.create({
      kind: 'post-delete',
      artifactRoot: root,
      sourceContainerId: 'exact-container-id',
      sourceRole: 'exact_source_role',
      sourceDatabase: 'exact_source_test',
      pgPassContainerPath: '/run/secrets/source.pgpass',
      timeoutMs: 120_000,
      priorArchive: preDelete,
    });
    expect(postDelete.fileName).toBe('post-delete.dump');
  });
});
