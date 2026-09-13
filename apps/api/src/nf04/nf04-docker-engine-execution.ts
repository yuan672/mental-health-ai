import { randomBytes } from 'node:crypto';
import { request, type RequestOptions } from 'node:http';
import type {
  Nf04ContainerExecExit,
  Nf04ContainerExecSpec,
  Nf04ContainerExecution,
  Nf04ContainerExecutionPort,
} from './nf04-container-execution';

const DEFAULT_DOCKER_PIPE = String.raw`\\.\pipe\docker_engine`;
const MAX_ENGINE_RESPONSE_BYTES = 64 * 1024;
export const NF04_DOCKER_EXEC_SUPERVISOR_SCRIPT = String.raw`set -eu
stop_marker="$1"
shift
work_dir=$(mktemp -d /tmp/mh-nf04-exec.XXXXXX)
status_file="$work_dir/status"
worker_pid=
terminate_workers() {
  [ -z "$worker_pid" ] || kill -TERM "$worker_pid" 2>/dev/null || true
}
cleanup() {
  rm -f "$status_file" "$stop_marker"
  rmdir "$work_dir" 2>/dev/null || true
}
trap 'terminate_workers; cleanup; exit 143' HUP INT TERM
(
  child_pid=
  terminate_child() {
    [ -z "$child_pid" ] || kill -TERM "$child_pid" 2>/dev/null || true
    attempts=0
    while [ -n "$child_pid" ] && kill -0 "$child_pid" 2>/dev/null && [ "$attempts" -lt 20 ]; do
      attempts=$((attempts + 1))
      sleep 0.1
    done
    [ -z "$child_pid" ] || kill -KILL "$child_pid" 2>/dev/null || true
  }
  trap terminate_child HUP INT TERM
  "$@" &
  child_pid=$!
  set +e
  wait "$child_pid"
  child_status=$?
  set -e
  printf '%s\n' "$child_status" > "$status_file"
  exit "$child_status"
) &
worker_pid=$!
while kill -0 "$worker_pid" 2>/dev/null; do
  if [ -f "$stop_marker" ]; then
    kill -TERM "$worker_pid" 2>/dev/null || true
    break
  fi
  sleep 0.05
done
set +e
wait "$worker_pid"
worker_status=$?
set -e
if [ -f "$status_file" ]; then
  child_status=$(cat "$status_file")
else
  child_status=$worker_status
fi
trap - HUP INT TERM
cleanup
exit "$child_status"`;

export class Nf04DockerEngineExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = Nf04DockerEngineExecutionError.name;
  }
}

export type Nf04DockerExecCreate = Readonly<{
  containerId: string;
  command: readonly string[];
  environment: readonly string[];
}>;

export type Nf04DockerExecInspection = Readonly<{
  id: string;
  containerId: string;
  running: boolean;
  pid: number | null;
  exitCode: number | null;
}>;

export interface Nf04DockerAttachConnection {
  requestStop(signal?: AbortSignal): Promise<void>;
}

/** Narrow seam used by barrier tests; the production implementation uses the Docker Engine API. */
export interface Nf04DockerEngineClient {
  createExec(input: Nf04DockerExecCreate, signal: AbortSignal): Promise<string>;
  startExec(
    execId: string,
    containerId: string,
    stopMarkerName: string,
    signal: AbortSignal,
  ): Promise<Nf04DockerAttachConnection>;
  inspectExec(execId: string, signal: AbortSignal): Promise<Nf04DockerExecInspection>;
}

export class DockerEngineNf04ContainerExecutionPort implements Nf04ContainerExecutionPort {
  constructor(
    private readonly engine: Nf04DockerEngineClient,
    private readonly requestTimeoutMs = 10_000,
    private readonly pollIntervalMs = 50,
  ) {
    if (requestTimeoutMs <= 0 || pollIntervalMs <= 0) {
      throw new Nf04DockerEngineExecutionError('Docker execution deadlines must be positive');
    }
  }

  async create(spec: Nf04ContainerExecSpec, signal?: AbortSignal): Promise<Nf04ContainerExecution> {
    validateSpec(spec);
    const stopMarkerName = `mh-nf04-stop-${randomBytes(16).toString('hex')}`;
    const stopMarkerPath = `/tmp/${stopMarkerName}`;
    const bounded = boundedSignal(signal, this.requestTimeoutMs);
    try {
      const execId = await this.engine.createExec(
        {
          containerId: spec.containerId,
          command: [
            '/bin/sh',
            '-c',
            NF04_DOCKER_EXEC_SUPERVISOR_SCRIPT,
            'nf04-supervisor',
            stopMarkerPath,
            spec.executable,
            ...spec.args,
          ],
          environment: Object.entries(spec.environment ?? {})
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, value]) => `${key}=${value}`),
        },
        bounded.signal,
      );
      if (!validIdentityPart(execId)) {
        throw new Nf04DockerEngineExecutionError('Docker Engine returned an invalid exec identity');
      }
      const inspection = await this.engine.inspectExec(execId, bounded.signal);
      assertInspection(inspection, execId, spec.containerId);
      if (inspection.running || (inspection.pid !== null && inspection.pid !== 0)) {
        throw new Nf04DockerEngineExecutionError(
          'Docker exec was not allocated in a stopped state',
        );
      }
      return new DockerEngineNf04ContainerExecution(
        this.engine,
        spec.containerId,
        execId,
        this.requestTimeoutMs,
        this.pollIntervalMs,
        stopMarkerName,
      );
    } finally {
      bounded.dispose();
    }
  }
}

class DockerEngineNf04ContainerExecution implements Nf04ContainerExecution {
  readonly localPid = 0;
  readonly identity;
  private startPromise: Promise<void> | undefined;
  private attach: Nf04DockerAttachConnection | undefined;
  private startAcknowledged = false;
  private runningObserved = false;
  private stopRequested = false;
  private terminal: Nf04ContainerExecExit | undefined;

  constructor(
    private readonly engine: Nf04DockerEngineClient,
    containerId: string,
    execId: string,
    private readonly requestTimeoutMs: number,
    private readonly pollIntervalMs: number,
    private readonly stopMarkerName: string,
  ) {
    this.identity = { containerId, execId };
  }

  start(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.stopRequested || this.startPromise) {
      return Promise.reject(
        new Nf04DockerEngineExecutionError('Docker exec start is no longer permitted'),
      );
    }
    this.startPromise = this.startOnce(signal);
    return this.startPromise;
  }

  async stop(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.stopRequested = true;
    if (this.attach) await this.attach.requestStop(signal);
    if (!this.startPromise) return;

    await observeSettled(this.startPromise, signal);
    if (this.attach) await this.attach.requestStop(signal);
    await this.waitForTerminal(signal);
  }

  async waitForExit(signal?: AbortSignal): Promise<Nf04ContainerExecExit> {
    signal?.throwIfAborted();
    if (!this.startPromise) {
      throw new Nf04DockerEngineExecutionError('Docker exec was never started');
    }
    await observeSettled(this.startPromise, signal);
    return this.waitForTerminal(signal);
  }

  private async startOnce(signal?: AbortSignal): Promise<void> {
    const bounded = boundedSignal(signal, this.requestTimeoutMs);
    try {
      const attach = await this.engine.startExec(
        this.identity.execId,
        this.identity.containerId,
        this.stopMarkerName,
        bounded.signal,
      );
      this.attach = attach;
      this.startAcknowledged = true;
      if (this.stopRequested || signal?.aborted) await attach.requestStop(bounded.signal);
      const inspection = await this.engine.inspectExec(this.identity.execId, bounded.signal);
      assertInspection(inspection, this.identity.execId, this.identity.containerId);
      if (inspection.running) this.runningObserved = true;
      else this.terminal = { exitCode: requireExitCode(inspection) };
    } finally {
      bounded.dispose();
    }
  }

  private async waitForTerminal(signal?: AbortSignal): Promise<Nf04ContainerExecExit> {
    if (this.terminal) return this.terminal;
    const bounded = boundedSignal(signal, 180_000);
    try {
      while (true) {
        const requestBound = boundedSignal(bounded.signal, this.requestTimeoutMs);
        let inspection: Nf04DockerExecInspection;
        try {
          inspection = await this.engine.inspectExec(this.identity.execId, requestBound.signal);
        } finally {
          requestBound.dispose();
        }
        assertInspection(inspection, this.identity.execId, this.identity.containerId);
        if (inspection.running) {
          this.runningObserved = true;
        } else {
          if (!this.startAcknowledged && !this.runningObserved) {
            throw new Nf04DockerEngineExecutionError('Docker exec exit could not be proven');
          }
          this.terminal = { exitCode: requireExitCode(inspection) };
          return this.terminal;
        }
        await abortableDelay(this.pollIntervalMs, bounded.signal);
      }
    } finally {
      bounded.dispose();
    }
  }
}

export class WindowsNamedPipeNf04DockerEngineClient implements Nf04DockerEngineClient {
  constructor(private readonly socketPath = DEFAULT_DOCKER_PIPE) {
    if (process.platform !== 'win32') {
      throw new Nf04DockerEngineExecutionError(
        'The NF-04 Docker Engine adapter requires the Windows named pipe',
      );
    }
  }

  async createExec(input: Nf04DockerExecCreate, signal: AbortSignal): Promise<string> {
    const response = await this.requestJson(
      'POST',
      `/containers/${encodeURIComponent(input.containerId)}/exec`,
      {
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        Cmd: input.command,
        Env: input.environment,
      },
      signal,
      201,
    );
    const id = isObject(response) ? response.Id : undefined;
    if (typeof id !== 'string') {
      throw new Nf04DockerEngineExecutionError('Docker Engine returned an invalid exec identity');
    }
    return id;
  }

  startExec(
    execId: string,
    containerId: string,
    stopMarkerName: string,
    signal: AbortSignal,
  ): Promise<Nf04DockerAttachConnection> {
    return this.startDetachedExec(execId, containerId, stopMarkerName, signal);
  }

  async inspectExec(execId: string, signal: AbortSignal): Promise<Nf04DockerExecInspection> {
    const response = await this.requestJson(
      'GET',
      `/exec/${encodeURIComponent(execId)}/json`,
      undefined,
      signal,
      200,
    );
    if (!isObject(response)) throw new Nf04DockerEngineExecutionError('Invalid Docker exec state');
    const { ID, ContainerID, Running, Pid, ExitCode } = response;
    if (
      typeof ID !== 'string' ||
      typeof ContainerID !== 'string' ||
      typeof Running !== 'boolean' ||
      (Pid !== null && (typeof Pid !== 'number' || !Number.isInteger(Pid))) ||
      (ExitCode !== null && (typeof ExitCode !== 'number' || !Number.isInteger(ExitCode)))
    ) {
      throw new Nf04DockerEngineExecutionError('Invalid Docker exec state');
    }
    return { id: ID, containerId: ContainerID, running: Running, pid: Pid, exitCode: ExitCode };
  }

  private requestJson(
    method: 'GET' | 'POST',
    path: string,
    payload: unknown,
    signal: AbortSignal,
    expectedStatus: number,
  ): Promise<unknown> {
    const body = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload), 'utf8');
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      let settled = false;
      const finish = (continuation: () => void) => {
        if (settled) return;
        settled = true;
        continuation();
      };
      const options: RequestOptions = {
        socketPath: this.socketPath,
        path,
        method,
        headers: body
          ? { 'content-type': 'application/json', 'content-length': String(body.byteLength) }
          : undefined,
        signal,
      };
      const req = request(options, (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on('data', (chunk: Buffer) => {
          length += chunk.byteLength;
          if (length > MAX_ENGINE_RESPONSE_BYTES) {
            req.destroy();
            finish(() =>
              reject(new Nf04DockerEngineExecutionError('Docker response was too large')),
            );
          } else chunks.push(chunk);
        });
        response.once('end', () => {
          if (response.statusCode !== expectedStatus) {
            finish(() =>
              reject(new Nf04DockerEngineExecutionError('Docker Engine request failed')),
            );
            return;
          }
          try {
            finish(() => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
          } catch {
            finish(() => reject(new Nf04DockerEngineExecutionError('Docker response was invalid')));
          }
        });
      });
      req.once('error', () =>
        finish(() => reject(new Nf04DockerEngineExecutionError('Docker Engine request failed'))),
      );
      if (body) req.end(body);
      else req.end();
    });
  }

  private async startDetachedExec(
    execId: string,
    containerId: string,
    stopMarkerName: string,
    signal: AbortSignal,
  ): Promise<Nf04DockerAttachConnection> {
    await this.requestBuffer(
      'POST',
      `/exec/${encodeURIComponent(execId)}/start`,
      Buffer.from(JSON.stringify({ Detach: true, Tty: false }), 'utf8'),
      'application/json',
      signal,
      200,
    );
    return new DockerStopMarkerConnection(this, containerId, stopMarkerName);
  }

  async createStopMarker(
    containerId: string,
    markerName: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (!/^[a-z0-9-]+$/u.test(markerName)) {
      throw new Nf04DockerEngineExecutionError('Docker stop marker identity is invalid');
    }
    await this.requestBuffer(
      'PUT',
      `/containers/${encodeURIComponent(containerId)}/archive?path=${encodeURIComponent('/tmp')}`,
      createEmptyTar(markerName),
      'application/x-tar',
      signal,
      200,
    );
  }

  private requestBuffer(
    method: 'POST' | 'PUT',
    path: string,
    body: Buffer,
    contentType: string,
    signal: AbortSignal,
    expectedStatus: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      let settled = false;
      const finish = (continuation: () => void) => {
        if (settled) return;
        settled = true;
        continuation();
      };
      const req = request({
        socketPath: this.socketPath,
        path,
        method,
        headers: { 'content-type': contentType, 'content-length': String(body.byteLength) },
        signal,
      });
      req.once('response', (response) => {
        response.resume();
        response.once('end', () => {
          if (response.statusCode === expectedStatus) finish(resolve);
          else
            finish(() =>
              reject(new Nf04DockerEngineExecutionError('Docker Engine request failed')),
            );
        });
      });
      req.once('error', () =>
        finish(() => reject(new Nf04DockerEngineExecutionError('Docker Engine request failed'))),
      );
      req.end(body);
    });
  }
}

class DockerStopMarkerConnection implements Nf04DockerAttachConnection {
  private stopRequested = false;

  constructor(
    private readonly engine: WindowsNamedPipeNf04DockerEngineClient,
    private readonly containerId: string,
    private readonly markerName: string,
  ) {}

  async requestStop(signal: AbortSignal = AbortSignal.timeout(10_000)): Promise<void> {
    if (this.stopRequested) return;
    this.stopRequested = true;
    await this.engine.createStopMarker(this.containerId, this.markerName, signal);
  }
}

function createEmptyTar(name: string): Buffer {
  const archive = Buffer.alloc(1536);
  const header = archive.subarray(0, 512);
  header.write(name, 0, 100, 'ascii');
  writeTarOctal(header, 100, 8, 0o600);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, 0);
  writeTarOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const encoded = checksum.toString(8).padStart(6, '0');
  header.write(encoded, 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return archive;
}

function writeTarOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, '0');
  buffer.write(encoded, offset, length - 1, 'ascii');
  buffer[offset + length - 1] = 0;
}

function validateSpec(spec: Nf04ContainerExecSpec): void {
  if (!validIdentityPart(spec.containerId) || !validIdentityPart(spec.executable)) {
    throw new Nf04DockerEngineExecutionError('Docker exec specification is invalid');
  }
  for (const [key, value] of Object.entries(spec.environment ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes('\0')) {
      throw new Nf04DockerEngineExecutionError('Docker exec environment is invalid');
    }
  }
  if (spec.args.some((argument) => argument.includes('\0'))) {
    throw new Nf04DockerEngineExecutionError('Docker exec argument is invalid');
  }
}

function assertInspection(
  inspection: Nf04DockerExecInspection,
  execId: string,
  containerId: string,
): void {
  if (inspection.id !== execId || inspection.containerId !== containerId) {
    throw new Nf04DockerEngineExecutionError('Docker exec identity changed');
  }
}

function requireExitCode(inspection: Nf04DockerExecInspection): number {
  if (inspection.exitCode === null) {
    throw new Nf04DockerEngineExecutionError('Docker exec exit code is unavailable');
  }
  return inspection.exitCode;
}

function validIdentityPart(value: string): boolean {
  return value.trim().length > 0 && !value.includes('\0');
}

function boundedSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Nf04DockerEngineExecutionError('Docker operation timed out')),
    timeoutMs,
  );
  timer.unref();
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
    },
  };
}

async function observeSettled(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  try {
    await raceAbort(
      promise.then(
        () => undefined,
        () => undefined,
      ),
      signal,
    );
  } catch {
    throw new Nf04DockerEngineExecutionError('Docker start reconciliation was interrupted');
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    function finish() {
      signal.removeEventListener('abort', abort);
      resolve();
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => finish(() => reject(signal.reason));
    const finish = (continuation: () => void) => {
      signal.removeEventListener('abort', abort);
      continuation();
    };
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
