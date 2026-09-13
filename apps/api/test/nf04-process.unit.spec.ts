import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeNf04ProcessRunner } from '../src/nf04/nf04-process';

describe('NF-04 structured process runner', () => {
  it('passes arguments without a shell and captures bounded output', async () => {
    const result = await new NodeNf04ProcessRunner().run({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write(process.argv[1])', 'literal;not-a-shell-command'],
      timeoutMs: 5_000,
    });
    expect(result).toEqual({
      exitCode: 0,
      signal: null,
      stdout: 'literal;not-a-shell-command',
      stderr: '',
      timedOut: false,
    });
  });

  it('enforces a deadline and settles the exact child process', async () => {
    const result = await new NodeNf04ProcessRunner().run({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => undefined, 1000)'],
      timeoutMs: 50,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode === null || result.exitCode !== 0).toBe(true);
  });

  it('refuses a process already cancelled before launch', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      new NodeNf04ProcessRunner().start({
        executable: process.execPath,
        args: ['-e', 'process.exit(0)'],
        timeoutMs: 5_000,
        signal: controller.signal,
      }),
    ).toThrow(/cancelled before launch/i);
  });

  it('can replace the inherited environment for the isolated API process', async () => {
    process.env.NF04_PARENT_ONLY_TEST_VALUE = 'must-not-cross-the-boundary';
    try {
      const result = await new NodeNf04ProcessRunner().run({
        executable: process.execPath,
        args: [
          '-e',
          'process.stdout.write(JSON.stringify({parent:process.env.NF04_PARENT_ONLY_TEST_VALUE ?? null,child:process.env.NF04_CHILD_ONLY_TEST_VALUE ?? null}))',
        ],
        environmentMode: 'replace',
        environment: { NF04_CHILD_ONLY_TEST_VALUE: 'synthetic-child-value' },
        timeoutMs: 5_000,
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        parent: null,
        child: 'synthetic-child-value',
      });
    } finally {
      delete process.env.NF04_PARENT_ONLY_TEST_VALUE;
    }
  });

  it('uses the exact requested working directory', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'mh-nf04-process-test-'));
    try {
      const result = await new NodeNf04ProcessRunner().run({
        executable: process.execPath,
        args: ['-e', 'process.stdout.write(process.cwd())'],
        workingDirectory,
        timeoutMs: 5_000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toLowerCase()).toBe(workingDirectory.toLowerCase());
    } finally {
      await rm(workingDirectory, { recursive: true, force: false });
    }
  });
});
