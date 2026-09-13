import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseNf04CliInvocation, runNf04DrillCommand } from '../src/commands/run-nf04-drill';
import { assertNf04IsolatedApiEnvironment } from '../src/commands/run-nf04-isolated-api';
import { nf04ExecutableManifestSchema } from '../src/nf04/nf04-contract';
import { Nf04PreparationService } from '../src/nf04/nf04-preparation';
import type {
  Nf04ProcessResult,
  Nf04ProcessRunner,
  Nf04ProcessSpec,
  Nf04RunningProcess,
} from '../src/nf04/nf04-process';

class CommandPreparationRunner implements Nf04ProcessRunner {
  readonly calls: Nf04ProcessSpec[] = [];

  async run(spec: Nf04ProcessSpec): Promise<Nf04ProcessResult> {
    this.calls.push(spec);
    if (spec.executable === 'git') {
      return commandResult(spec.args[0] === 'status' ? '' : `${'a'.repeat(40)}\n`);
    }
    if (spec.executable === 'docker') {
      return commandResult(
        `${JSON.stringify({
          Id: `sha256:${'b'.repeat(64)}`,
          RepoDigests: [`postgres@sha256:${'c'.repeat(64)}`],
        })}\n`,
      );
    }
    if (spec.executable === 'whoami') {
      return commandResult('"SYNTHETIC\\operator","S-1-5-21-1000"\n');
    }
    if (spec.executable === 'icacls') return commandResult('');
    return { ...commandResult(''), exitCode: 1 };
  }

  start(): Nf04RunningProcess {
    throw new Error('preparation must not start a process');
  }
}

describe('NF-04 protected command entry', () => {
  const manifestPath = resolve('synthetic-manifest.json');
  const runId = '20260913-170000-a1b2c3d4';

  it('does not run a default drill when no explicit subcommand is supplied', async () => {
    await expect(runNf04DrillCommand([], {})).rejects.toThrow(/Usage:/i);
  });

  it('preserves the narrow manifest validation and fixture-loading commands', () => {
    expect(parseNf04CliInvocation(['validate-manifest', manifestPath], {})).toEqual({
      command: 'validate-manifest',
      manifestPath,
    });
    expect(parseNf04CliInvocation(['load-fixture', manifestPath], {})).toEqual({
      command: 'load-fixture',
      manifestPath,
    });
  });

  it('requires the explicit test-only preparation gate and exact run confirmation', () => {
    const args = ['prepare-run', runId, '55431', '55432', '55433', '--confirm-run-id', runId];
    expect(() => parseNf04CliInvocation(args, {})).toThrow(/explicit.*gate/i);
    expect(() =>
      parseNf04CliInvocation(args, { APP_ENV: 'production', NF04_PREPARE_ENABLED: 'true' }),
    ).toThrow(/APP_ENV=test/i);
    expect(parseNf04CliInvocation(args, { APP_ENV: 'test', NF04_PREPARE_ENABLED: 'true' })).toEqual(
      {
        command: 'prepare-run',
        runId,
        sourceDatabasePort: 55_431,
        restoreDatabasePort: 55_432,
        isolatedApiPort: 55_433,
      },
    );
    expect(() =>
      parseNf04CliInvocation([...args.slice(0, -1), '20260913-170000-ffffffff'], {
        APP_ENV: 'test',
        NF04_PREPARE_ENABLED: 'true',
      }),
    ).toThrow(/confirmation/i);
  });

  it('projects a validated CLI invocation into the strict preparation request', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'mh-nf04-command-'));
    const repositoryRoot = join(temporaryRoot, 'mental-health-ai');
    const workingDirectory = join(repositoryRoot, 'apps', 'api');
    const migrationsRoot = join(repositoryRoot, 'database', 'migrations');
    const previousAppEnv = process.env.APP_ENV;
    const previousGate = process.env.NF04_PREPARE_ENABLED;
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await mkdir(workingDirectory, { recursive: true });
      await mkdir(join(migrationsRoot, 'meta'), { recursive: true });
      await mkdir(join(temporaryRoot, 'handoff'));
      await writeFile(
        join(migrationsRoot, 'meta', '_journal.json'),
        JSON.stringify({ entries: [{ idx: 0, tag: '0000_synthetic', when: 1 }] }),
      );
      await writeFile(join(migrationsRoot, '0000_synthetic.sql'), 'SELECT 1;\n');
      process.env.APP_ENV = 'test';
      process.env.NF04_PREPARE_ENABLED = 'true';
      const runner = new CommandPreparationRunner();
      const [sourceDatabasePort, restoreDatabasePort, isolatedApiPort] =
        await reserveUnusedPorts(3);
      if (!sourceDatabasePort || !restoreDatabasePort || !isolatedApiPort) {
        throw new Error('three test ports were not allocated');
      }
      const args = [
        'prepare-run',
        runId,
        String(sourceDatabasePort),
        String(restoreDatabasePort),
        String(isolatedApiPort),
        '--confirm-run-id',
        runId,
      ];

      await expect(
        runNf04DrillCommand(
          args,
          { APP_ENV: 'test', NF04_PREPARE_ENABLED: 'true' },
          workingDirectory,
          new Nf04PreparationService(runner, 'win32', async () => 3n * 1024n * 1024n * 1024n),
        ),
      ).resolves.toBe(true);

      const manifest = nf04ExecutableManifestSchema.parse(
        JSON.parse(
          await readFile(
            join(temporaryRoot, 'handoff', 'nf04-backup-restore', runId, 'manifest.json'),
            'utf8',
          ),
        ),
      );
      expect(manifest.state).toBe('planned');
      expect(manifest.ports).toEqual({
        sourceDatabase: sourceDatabasePort,
        restoreDatabase: restoreDatabasePort,
        isolatedApi: isolatedApiPort,
      });
      expect(runner.calls.map((call) => call.executable)).toEqual([
        'git',
        'git',
        'docker',
        'whoami',
        'icacls',
      ]);
      expect(stdout).toHaveBeenCalledWith(
        `${JSON.stringify({ event: 'nf04_run_prepared', runId, state: 'planned' })}\n`,
      );
    } finally {
      stdout.mockRestore();
      if (previousAppEnv === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = previousAppEnv;
      if (previousGate === undefined) delete process.env.NF04_PREPARE_ENABLED;
      else process.env.NF04_PREPARE_ENABLED = previousGate;
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('requires a separate full-drill gate, absolute manifest and exact run confirmation input', () => {
    const args = ['execute-run', manifestPath, '--confirm-run-id', runId];
    expect(() => parseNf04CliInvocation(args, {})).toThrow(/explicit.*gate/i);
    expect(
      parseNf04CliInvocation(args, { APP_ENV: 'test', NF04_FULL_DRILL_ENABLED: 'true' }),
    ).toEqual({ command: 'execute-run', manifestPath, runId });
    expect(() =>
      parseNf04CliInvocation(['execute-run', 'relative.json', '--confirm-run-id', runId], {
        APP_ENV: 'test',
        NF04_FULL_DRILL_ENABLED: 'true',
      }),
    ).toThrow(/absolute/i);
  });

  it('allows the deletion API bootstrap only on the explicit loopback test boundary', () => {
    const allowed = {
      APP_ENV: 'test',
      NF04_ISOLATED_API: 'true',
      ACCOUNT_DELETION_ENABLED: 'true',
      ADMIN_AUTH_ENABLED: 'false',
      AI_CHAT_ENABLED: 'false',
      AI_KNOWLEDGE_ENABLED: 'false',
      LLM_PROVIDER: 'none',
      WEB_ORIGINS: 'http://127.0.0.1:55433',
    };
    expect(() => assertNf04IsolatedApiEnvironment(allowed)).not.toThrow();
    expect(() =>
      assertNf04IsolatedApiEnvironment({ ...allowed, WEB_ORIGINS: 'http://0.0.0.0:55433' }),
    ).toThrow(/not authorized/i);
    expect(() =>
      assertNf04IsolatedApiEnvironment({ ...allowed, NF04_ISOLATED_API: 'false' }),
    ).toThrow(/not authorized/i);
  });
});

function commandResult(stdout: string): Nf04ProcessResult {
  return { exitCode: 0, signal: null, stdout, stderr: '', timedOut: false };
}

async function reserveUnusedPorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const port = await new Promise<number>((resolvePort, rejectPort) => {
      const server = createServer();
      server.once('error', rejectPort);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          server.close();
          rejectPort(new Error('test port allocation failed'));
          return;
        }
        server.close((error) => (error ? rejectPort(error) : resolvePort(address.port)));
      });
    });
    ports.push(port);
  }
  return ports;
}
