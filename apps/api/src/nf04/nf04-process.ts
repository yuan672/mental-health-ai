import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export type Nf04ProcessSpec = Readonly<{
  executable: string;
  args: readonly string[];
  environment?: Readonly<Record<string, string>>;
  sensitiveStdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}>;

export type Nf04ProcessResult = Readonly<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}>;

export interface Nf04RunningProcess {
  readonly localPid: number;
  readonly startedAt: Date;
  readonly result: Promise<Nf04ProcessResult>;
  stop(): void;
}

export interface Nf04ProcessRunner {
  run(spec: Nf04ProcessSpec): Promise<Nf04ProcessResult>;
  start(spec: Nf04ProcessSpec): Nf04RunningProcess;
}

export class Nf04ProcessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = Nf04ProcessError.name;
  }
}

const MAX_CAPTURE_BYTES = 1024 * 1024;

export class NodeNf04ProcessRunner implements Nf04ProcessRunner {
  async run(spec: Nf04ProcessSpec): Promise<Nf04ProcessResult> {
    return this.start(spec).result;
  }

  start(spec: Nf04ProcessSpec): Nf04RunningProcess {
    if (spec.timeoutMs <= 0) throw new Nf04ProcessError('Process timeout must be positive');
    if (spec.signal?.aborted) throw new Nf04ProcessError('Process was cancelled before launch');

    const child = spawn(spec.executable, [...spec.args], {
      env: { ...process.env, ...spec.environment },
      shell: false,
      stdio: 'pipe',
      windowsHide: true,
    });
    if (!child.pid) throw new Nf04ProcessError('Process did not expose a local PID');
    const startedAt = new Date();
    let timedOut = false;
    let forceKillTimeout: NodeJS.Timeout | undefined;
    const requestStop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      if (!forceKillTimeout) {
        forceKillTimeout = setTimeout(() => child.kill('SIGKILL'), 2_000);
        forceKillTimeout.unref();
      }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      requestStop();
    }, spec.timeoutMs);
    timeout.unref();

    const abort = () => requestStop();
    spec.signal?.addEventListener('abort', abort, { once: true });
    if (spec.sensitiveStdin === undefined) child.stdin.end();
    else child.stdin.end(spec.sensitiveStdin, 'utf8');

    const result = collectProcessResult(child, () => {
      clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      spec.signal?.removeEventListener('abort', abort);
    }).then((value) => ({ ...value, timedOut }));

    return {
      localPid: child.pid,
      startedAt,
      result,
      stop: requestStop,
    };
  }
}

function collectProcessResult(
  child: ChildProcessWithoutNullStreams,
  cleanup: () => void,
): Promise<Omit<Nf04ProcessResult, 'timedOut'>> {
  return new Promise((resolve, reject) => {
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const append = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer<ArrayBufferLike>,
    ): Buffer<ArrayBufferLike> => {
      const remaining = MAX_CAPTURE_BYTES - current.length;
      return remaining <= 0 ? current : Buffer.concat([current, chunk.subarray(0, remaining)]);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('close', (exitCode, signal) => {
      cleanup();
      resolve({
        exitCode,
        signal,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
      });
    });
  });
}
