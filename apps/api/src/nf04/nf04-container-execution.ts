/**
 * Stable Docker/OCI exec identity. A host-side CLI PID is deliberately not part
 * of this proof: the CLI can exit before the process represented by execId does.
 */
export type Nf04ContainerExecIdentity = Readonly<{
  containerId: string;
  execId: string;
}>;

export type Nf04ContainerExecSpec = Readonly<{
  containerId: string;
  executable: string;
  args: readonly string[];
  environment?: Readonly<Record<string, string>>;
}>;

export type Nf04ContainerExecExit = Readonly<{
  /** A definite code read from the same exec object after it has stopped. */
  exitCode: number;
}>;

/**
 * A controlled handle for one exact container exec. Implementations may use a
 * host helper internally, but must inspect/control identity.execId itself.
 * start, stop and waitForExit must observe AbortSignal, settle or reject when it
 * aborts, and never begin a side effect after observing an aborted signal. stop
 * is also the synchronization barrier for an in-flight start: when stop resolves,
 * that start can no longer make the exec run later and the exact exec is stopped.
 * If an implementation cannot prove this, stop must reject. waitForExit resolves
 * only after this exact exec is terminal and must return a definite exit code; it
 * may be called again after an earlier interrupted wait. No method may create a
 * replacement/follow-up exec.
 */
export interface Nf04ContainerExecution {
  readonly identity: Nf04ContainerExecIdentity;
  /** Diagnostic only. It is never accepted as container-exit evidence. */
  readonly localPid: number;
  start(signal?: AbortSignal): Promise<void>;
  stop(signal?: AbortSignal): Promise<void>;
  waitForExit(signal?: AbortSignal): Promise<Nf04ContainerExecExit>;
}

/**
 * create must only allocate an unstarted exact exec. If it rejects, it must not
 * have started a container process. This two-step contract preserves the exec ID
 * even when the subsequent start acknowledgement is lost or times out. create,
 * like all handle methods, must settle or reject when its AbortSignal aborts.
 */
export interface Nf04ContainerExecutionPort {
  create(spec: Nf04ContainerExecSpec, signal?: AbortSignal): Promise<Nf04ContainerExecution>;
}
