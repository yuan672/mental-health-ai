import {
  DockerEngineNf04ContainerExecutionPort,
  type Nf04DockerAttachConnection,
  type Nf04DockerEngineClient,
  type Nf04DockerExecCreate,
  type Nf04DockerExecInspection,
} from '../src/nf04/nf04-docker-engine-execution';

const CONTAINER_ID = 'a'.repeat(64);
const EXEC_ID = 'b'.repeat(64);
const stopped = (): Nf04DockerExecInspection => ({
  id: EXEC_ID,
  containerId: CONTAINER_ID,
  running: false,
  pid: 0,
  exitCode: 0,
});
const running = (): Nf04DockerExecInspection => ({
  ...stopped(),
  running: true,
  pid: 42,
});

class FakeAttach implements Nf04DockerAttachConnection {
  stopRequestCount = 0;
  async requestStop(): Promise<void> {
    this.stopRequestCount += 1;
  }
}

class FakeEngine implements Nf04DockerEngineClient {
  readonly creates: Nf04DockerExecCreate[] = [];
  readonly starts: string[] = [];
  readonly inspections: string[] = [];
  readonly attach = new FakeAttach();
  inspectResults: Array<Nf04DockerExecInspection | Promise<Nf04DockerExecInspection>> = [stopped()];
  startResult: Promise<Nf04DockerAttachConnection> = Promise.resolve(this.attach);

  async createExec(input: Nf04DockerExecCreate): Promise<string> {
    this.creates.push(input);
    return EXEC_ID;
  }

  startExec(execId: string): Promise<Nf04DockerAttachConnection> {
    this.starts.push(execId);
    return this.startResult;
  }

  inspectExec(execId: string): Promise<Nf04DockerExecInspection> {
    this.inspections.push(execId);
    return Promise.resolve(this.inspectResults.shift() ?? stopped());
  }
}

const SPEC = {
  containerId: CONTAINER_ID,
  executable: 'pg_restore',
  args: ['--single-transaction', '/nf04-input/pre-delete.dump'],
  environment: { PGAPPNAME: 'nf04-restore', PGPASSFILE: '/run/secrets/restore.pgpass' },
} as const;

describe('NF-04 Docker Engine exact exec adapter', () => {
  it('allocates an unstarted exact exec with the fixed stdin supervisor', async () => {
    const engine = new FakeEngine();
    const execution = await new DockerEngineNf04ContainerExecutionPort(engine).create(SPEC);

    expect(execution.identity).toEqual({ containerId: CONTAINER_ID, execId: EXEC_ID });
    expect(engine.starts).toEqual([]);
    expect(engine.creates).toHaveLength(1);
    expect(engine.creates[0]).toEqual(
      expect.objectContaining({
        containerId: CONTAINER_ID,
        command: expect.arrayContaining([
          '/bin/sh',
          '-c',
          expect.stringContaining('while kill -0'),
          'nf04-supervisor',
          'pg_restore',
          '--single-transaction',
        ]),
        environment: ['PGAPPNAME=nf04-restore', 'PGPASSFILE=/run/secrets/restore.pgpass'],
      }),
    );
  });

  it('prevents a future start when stop wins before dispatch', async () => {
    const engine = new FakeEngine();
    const execution = await new DockerEngineNf04ContainerExecutionPort(engine).create(SPEC);

    await execution.stop();
    await expect(execution.start()).rejects.toThrow(/no longer permitted/i);
    expect(engine.starts).toEqual([]);
  });

  it('closes the same attach connection and requires exact exec terminal inspection', async () => {
    const engine = new FakeEngine();
    engine.inspectResults = [stopped(), running(), running(), { ...stopped(), exitCode: 143 }];
    const execution = await new DockerEngineNf04ContainerExecutionPort(engine, 1_000, 1).create(
      SPEC,
    );
    await execution.start();

    await execution.stop();
    await expect(execution.waitForExit()).resolves.toEqual({ exitCode: 143 });
    expect(engine.attach.stopRequestCount).toBeGreaterThanOrEqual(1);
    expect(engine.starts).toEqual([EXEC_ID]);
    expect(engine.inspections.every((id) => id === EXEC_ID)).toBe(true);
  });

  it('serializes an in-flight start with stop and closes a late attach before exit proof', async () => {
    const engine = new FakeEngine();
    const start = deferred<Nf04DockerAttachConnection>();
    engine.startResult = start.promise;
    engine.inspectResults = [stopped(), running(), { ...stopped(), exitCode: 143 }];
    const execution = await new DockerEngineNf04ContainerExecutionPort(engine, 1_000, 1).create(
      SPEC,
    );

    const starting = execution.start();
    const stopping = execution.stop();
    expect(engine.attach.stopRequestCount).toBe(0);
    start.resolve(engine.attach);
    await starting;
    await stopping;

    expect(engine.attach.stopRequestCount).toBeGreaterThanOrEqual(1);
    expect(engine.starts).toEqual([EXEC_ID]);
  });

  it('keeps acknowledgement loss quarantined unless running was independently observed', async () => {
    const engine = new FakeEngine();
    engine.startResult = Promise.reject(new Error('lost acknowledgement'));
    engine.inspectResults = [stopped(), stopped()];
    const execution = await new DockerEngineNf04ContainerExecutionPort(engine, 1_000, 1).create(
      SPEC,
    );

    await expect(execution.start()).rejects.toThrow('lost acknowledgement');
    await expect(execution.stop()).rejects.toThrow(/could not be proven/i);
  });

  it('rejects a mismatched exec/container identity', async () => {
    const engine = new FakeEngine();
    engine.inspectResults = [{ ...stopped(), containerId: 'replacement' }];
    await expect(new DockerEngineNf04ContainerExecutionPort(engine).create(SPEC)).rejects.toThrow(
      /identity changed/i,
    );
    expect(engine.starts).toEqual([]);
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}
