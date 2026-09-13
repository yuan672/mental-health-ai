import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { nf04ExecutableManifestSchema } from '../src/nf04/nf04-contract';
import { Nf04PreparationService } from '../src/nf04/nf04-preparation';
import type {
  Nf04ProcessResult,
  Nf04ProcessRunner,
  Nf04ProcessSpec,
  Nf04RunningProcess,
} from '../src/nf04/nf04-process';

class PreparationRunner implements Nf04ProcessRunner {
  readonly calls: Nf04ProcessSpec[] = [];
  dirty = false;

  async run(spec: Nf04ProcessSpec): Promise<Nf04ProcessResult> {
    this.calls.push(spec);
    if (spec.executable === 'git') {
      return spec.args[0] === 'status'
        ? result(this.dirty ? '?? unreviewed-helper.ps1\n' : '')
        : result(`${'a'.repeat(40)}\n`);
    }
    if (spec.executable === 'docker') {
      return result(
        `${JSON.stringify({
          Id: `sha256:${'b'.repeat(64)}`,
          RepoDigests: [`postgres@sha256:${'c'.repeat(64)}`],
        })}\n`,
      );
    }
    if (spec.executable === 'whoami') {
      return result('"SYNTHETIC\\operator","S-1-5-21-1000"\n');
    }
    if (spec.executable === 'icacls') return result('');
    return { ...result(''), exitCode: 1 };
  }

  start(): Nf04RunningProcess {
    throw new Error('preparation must not start a process');
  }
}

describe('NF-04 protected run preparation', () => {
  let temporaryRoot: string;
  const originalAppEnv = process.env.APP_ENV;
  const originalGate = process.env.NF04_PREPARE_ENABLED;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'mh-nf04-prepare-'));
    process.env.APP_ENV = 'test';
    process.env.NF04_PREPARE_ENABLED = 'true';
  });

  afterEach(async () => {
    if (originalAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = originalAppEnv;
    if (originalGate === undefined) delete process.env.NF04_PREPARE_ENABLED;
    else process.env.NF04_PREPARE_ENABLED = originalGate;
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('creates reviewable protected material without starting Docker or the drill', async () => {
    const repositoryRoot = join(temporaryRoot, 'mental-health-ai');
    const migrations = join(repositoryRoot, 'database', 'migrations');
    await mkdir(join(migrations, 'meta'), { recursive: true });
    await mkdir(join(dirname(repositoryRoot), 'handoff'));
    await writeFile(
      join(migrations, 'meta', '_journal.json'),
      JSON.stringify({ entries: [{ idx: 0, tag: '0000_synthetic', when: 1 }] }),
    );
    await writeFile(join(migrations, '0000_synthetic.sql'), 'SELECT 1;\n');
    const runner = new PreparationRunner();
    const [sourceDatabasePort, restoreDatabasePort, isolatedApiPort] = await reserveUnusedPorts(3);
    if (!sourceDatabasePort || !restoreDatabasePort || !isolatedApiPort) {
      throw new Error('three test ports were not allocated');
    }

    const prepared = await new Nf04PreparationService(
      runner,
      'win32',
      async () => 3n * 1024n * 1024n * 1024n,
    ).prepare(repositoryRoot, {
      runId: '20260913-143000-a1b2c3d4',
      sourceDatabasePort,
      restoreDatabasePort,
      isolatedApiPort,
    });

    const manifest = nf04ExecutableManifestSchema.parse(
      JSON.parse(await readFile(prepared.manifestPath, 'utf8')),
    );
    expect(manifest.state).toBe('planned');
    expect(manifest.repository.migrationCreatedAt).toEqual([1]);
    expect(manifest.archivesRoot).toBe(join(manifest.artifactRoot, 'archives'));
    expect(
      Object.values(manifest.files).every((path) => path.startsWith(manifest.artifactRoot)),
    ).toBe(true);
    expect(runner.calls.map((call) => call.executable)).toEqual([
      'git',
      'git',
      'docker',
      'whoami',
      'icacls',
    ]);
    expect(runner.calls.some((call) => call.args.includes('run'))).toBe(false);
    const serializedManifest = await readFile(prepared.manifestPath, 'utf8');
    expect(serializedManifest).not.toContain('Synthetic-');
    expect(serializedManifest).not.toContain('postgresql://');
  });

  it('fails closed unless the explicit test-only preparation gate is present', async () => {
    delete process.env.NF04_PREPARE_ENABLED;
    const runner = new PreparationRunner();
    await expect(
      new Nf04PreparationService(runner, 'win32').prepare(join(temporaryRoot, 'repository'), {
        runId: '20260913-143000-a1b2c3d4',
        sourceDatabasePort: 61_001,
        restoreDatabasePort: 61_002,
        isolatedApiPort: 61_003,
      }),
    ).rejects.toThrow(/explicit test-only gate/i);
    expect(runner.calls).toHaveLength(0);
  });

  it('rejects unknown request fields before running any prerequisite', async () => {
    const runner = new PreparationRunner();
    await expect(
      new Nf04PreparationService(runner, 'win32').prepare(join(temporaryRoot, 'repository'), {
        runId: '20260913-143000-a1b2c3d4',
        sourceDatabasePort: 61_001,
        restoreDatabasePort: 61_002,
        isolatedApiPort: 61_003,
        command: 'prepare-run',
      } as never),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(runner.calls).toHaveLength(0);
  });

  it('creates no run material from a dirty or untracked checkout', async () => {
    const runner = new PreparationRunner();
    runner.dirty = true;
    await expect(
      new Nf04PreparationService(runner, 'win32').prepare(join(temporaryRoot, 'repository'), {
        runId: '20260913-143000-a1b2c3d4',
        sourceDatabasePort: 61_001,
        restoreDatabasePort: 61_002,
        isolatedApiPort: 61_003,
      }),
    ).rejects.toThrow(/clean reviewed checkout/i);
    expect(runner.calls).toHaveLength(1);
  });

  it('refuses to create a run when the reviewed free-space bound is unavailable', async () => {
    const repositoryRoot = join(temporaryRoot, 'mental-health-ai');
    const migrations = join(repositoryRoot, 'database', 'migrations');
    await mkdir(join(migrations, 'meta'), { recursive: true });
    await mkdir(join(dirname(repositoryRoot), 'handoff'));
    await writeFile(
      join(migrations, 'meta', '_journal.json'),
      JSON.stringify({ entries: [{ idx: 0, tag: '0000_synthetic', when: 1 }] }),
    );
    await writeFile(join(migrations, '0000_synthetic.sql'), 'SELECT 1;\n');
    const runner = new PreparationRunner();
    const ports = await reserveUnusedPorts(3);

    await expect(
      new Nf04PreparationService(
        runner,
        'win32',
        async () => 2n * 1024n * 1024n * 1024n - 1n,
      ).prepare(repositoryRoot, {
        runId: '20260913-143000-a1b2c3d4',
        sourceDatabasePort: ports[0]!,
        restoreDatabasePort: ports[1]!,
        isolatedApiPort: ports[2]!,
      }),
    ).rejects.toThrow(/free-space safety limit/i);
    await expect(
      readFile(
        join(
          dirname(repositoryRoot),
          'handoff',
          'nf04-backup-restore',
          '20260913-143000-a1b2c3d4',
          'manifest.json',
        ),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

function result(stdout: string): Nf04ProcessResult {
  return { exitCode: 0, signal: null, stdout, stderr: '', timedOut: false };
}

async function reserveUnusedPorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  for (let index = 0; index < count; index += 1) {
    ports.push(
      await new Promise<number>((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
          const address = server.address();
          if (!address || typeof address === 'string') {
            server.close();
            reject(new Error('port allocation failed'));
            return;
          }
          server.close((error) => (error ? reject(error) : resolve(address.port)));
        });
      }),
    );
  }
  return ports;
}
