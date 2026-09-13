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
});
