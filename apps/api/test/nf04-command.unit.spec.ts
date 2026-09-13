import { resolve } from 'node:path';
import { parseNf04CliInvocation, runNf04DrillCommand } from '../src/commands/run-nf04-drill';
import { assertNf04IsolatedApiEnvironment } from '../src/commands/run-nf04-isolated-api';

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
