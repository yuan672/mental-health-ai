import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { access, lstat, open, type FileHandle } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type {
  Nf04ContainerExecExit,
  Nf04ContainerExecIdentity,
  Nf04ContainerExecution,
  Nf04ContainerExecutionPort,
} from './nf04-container-execution';
import { NF04_TOTAL_ARCHIVE_LIMIT_BYTES } from './nf04-contract';
import {
  assertNf04PathOwnedByRoot,
  assertNf04TrustedArtifactRoot,
  type Nf04FilesystemIdentity,
  type Nf04PathOwnershipSnapshot,
} from './nf04-guards';
import type { Nf04ProcessRunner } from './nf04-process';

export type Nf04ArchiveKind = 'pre-delete' | 'post-delete';

export type Nf04ArchiveEvidence = Readonly<{
  fileName: `${Nf04ArchiveKind}.dump`;
  byteSize: number;
  sha256: string;
  completedAt: string;
  listedWithPgRestore: true;
}>;

export class Nf04ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = Nf04ArchiveError.name;
  }
}

export type Nf04ArchiveWriterMonitorInput = Readonly<{
  execution: Nf04ContainerExecution;
  identity: Nf04ContainerExecIdentity;
  partialPath: string;
  maximumBytes: number;
  operationSignal: AbortSignal;
  deadlineExpired(): boolean;
}>;

export interface Nf04ArchiveWriterMonitor {
  waitForCompletion(input: Nf04ArchiveWriterMonitorInput): Promise<Nf04ContainerExecExit>;
}

export interface Nf04ArchivePublicationPort {
  /**
   * Atomically makes finalPath name the exact expected partial file without
   * clobbering an existing target, then removes the partial name. Implementations
   * must bind both operations to the captured directory/file identities using
   * platform-safe relative-handle primitives. A pathname-only check followed by
   * link/rename/unlink is not sufficient. On rejection, normal restore/cleanup
   * must continue to treat every possible output as quarantined.
   */
  publish(
    input: Readonly<{
      artifactRoot: string;
      partialPath: string;
      finalPath: string;
      rootIdentity: Nf04FilesystemIdentity;
      parentIdentity: Nf04FilesystemIdentity;
      partialIdentity: Nf04FilesystemIdentity;
      signal: AbortSignal;
    }>,
  ): Promise<void>;
}

type WriterLifecycleEvent =
  | Readonly<{ status: 'started' }>
  | Readonly<{ status: 'completed'; result: Nf04ContainerExecExit }>
  | Readonly<{ status: 'unconfirmed' }>;

type ArchiveStopReason =
  | 'Archive writer exceeded the remaining capacity'
  | 'Archive writer exceeded its operation deadline'
  | 'Archive writer lifecycle was interrupted'
  | 'Archive partial could not be inspected safely'
  | 'Archive partial is not a regular file'
  | 'Archive writer was cancelled';

const POLL = Symbol('nf04-archive-poll');
const ABORTED = Symbol('nf04-archive-aborted');

/**
 * Supervises the one process that owns the partial archive. Publication is only
 * possible after this monitor returns a confirmed process result. Any stop path
 * throws, including when a concurrent/late process completion reports success.
 */
export class PollingNf04ArchiveWriterMonitor implements Nf04ArchiveWriterMonitor {
  constructor(
    private readonly pollIntervalMs = 100,
    private readonly stopConfirmationTimeoutMs = 5_000,
    private readonly inspectPartial: (path: string) => Promise<Stats> = lstat,
  ) {
    if (pollIntervalMs <= 0 || stopConfirmationTimeoutMs <= 0) {
      throw new Nf04ArchiveError('Archive monitor deadlines must be positive');
    }
  }

  async waitForCompletion(input: Nf04ArchiveWriterMonitorInput): Promise<Nf04ContainerExecExit> {
    if (input.maximumBytes <= 0) {
      throw new Nf04ArchiveError('Archive writer exceeded the remaining capacity');
    }
    if (input.operationSignal.aborted) throw archiveOperationStopped(input);

    let lifecycle = settleStart(input.execution.start(input.operationSignal));
    while (true) {
      const observed = await waitForWriterEvent(
        lifecycle,
        this.pollIntervalMs,
        input.operationSignal,
      );
      if (observed === ABORTED || input.operationSignal.aborted) {
        return this.stopWriter(input, archiveOperationStopReason(input));
      }
      if (observed !== POLL) {
        if (observed.status === 'unconfirmed') {
          return this.stopWriter(input, 'Archive writer lifecycle was interrupted');
        }
        assertExactExecutionIdentity(input.execution, input.identity);
        if (observed.status === 'started') {
          lifecycle = settleExit(input.execution.waitForExit(input.operationSignal));
          continue;
        }
        return observed.result;
      }

      let partial: Stats;
      try {
        partial = await this.inspectPartial(input.partialPath);
      } catch (error) {
        if (isErrno(error, 'ENOENT')) continue;
        return this.stopWriter(input, 'Archive partial could not be inspected safely');
      }
      if (!partial.isFile()) {
        return this.stopWriter(input, 'Archive partial is not a regular file');
      }
      if (partial.size > input.maximumBytes) {
        return this.stopWriter(input, 'Archive writer exceeded the remaining capacity');
      }
      assertExactExecutionIdentity(input.execution, input.identity);
    }
  }

  private async stopWriter(
    input: Pick<Nf04ArchiveWriterMonitorInput, 'execution' | 'identity'>,
    reason: ArchiveStopReason,
  ): Promise<never> {
    assertExactExecutionIdentity(input.execution, input.identity);
    const stopDeadline = createDeadline(this.stopConfirmationTimeoutMs);
    try {
      await input.execution.stop(stopDeadline.signal);
      assertExactExecutionIdentity(input.execution, input.identity);
      await input.execution.waitForExit(stopDeadline.signal);
      assertExactExecutionIdentity(input.execution, input.identity);
    } catch {
      throw new Nf04ArchiveError('Archive writer exit could not be confirmed');
    } finally {
      stopDeadline.dispose();
    }
    throw new Nf04ArchiveError(reason);
  }
}

export class Nf04ArchiveManager {
  constructor(
    private readonly listingRunner: Nf04ProcessRunner,
    private readonly executionPort: Nf04ContainerExecutionPort,
    private readonly publicationPort: Nf04ArchivePublicationPort,
    private readonly now: () => Date = () => new Date(),
    private readonly writerMonitor: Nf04ArchiveWriterMonitor = new PollingNf04ArchiveWriterMonitor(),
  ) {}

  async create(input: {
    kind: Nf04ArchiveKind;
    repositoryRoot: string;
    artifactRoot: string;
    runId: string;
    sourceContainerId: string;
    sourceRole: string;
    sourceDatabase: string;
    pgPassContainerPath: string;
    timeoutMs: number;
    priorArchive?: Nf04ArchiveEvidence;
    signal?: AbortSignal;
  }): Promise<Nf04ArchiveEvidence> {
    const trustedRootIdentity = await assertNf04TrustedArtifactRoot(input);
    const finalName = `${input.kind}.dump` as const;
    const partialName = `.${finalName}.partial`;
    const partialPath = join(input.artifactRoot, partialName);
    const finalPath = join(input.artifactRoot, finalName);
    const priorArchiveBytes = await this.verifyPriorArchive(input);
    const maximumBytes = NF04_TOTAL_ARCHIVE_LIMIT_BYTES - priorArchiveBytes;
    if (maximumBytes <= 0) {
      throw new Nf04ArchiveError('No archive capacity remains for this recovery point');
    }
    const initialPartialBoundary = await assertNf04PathOwnedByRoot(
      input.artifactRoot,
      partialPath,
      'absent',
    );
    const initialFinalBoundary = await assertNf04PathOwnedByRoot(
      input.artifactRoot,
      finalPath,
      'absent',
    );
    assertTrustedRootIdentity(initialPartialBoundary, trustedRootIdentity);
    assertTrustedRootIdentity(initialFinalBoundary, trustedRootIdentity);
    await assertNf04ArchivePathAbsent(partialPath);
    await assertNf04ArchivePathAbsent(finalPath);

    const operationDeadline = createDeadline(input.timeoutMs, input.signal);
    let execution: Nf04ContainerExecution;
    try {
      execution = await this.executionPort.create(
        {
          containerId: input.sourceContainerId,
          executable: 'pg_dump',
          environment: { PGPASSFILE: input.pgPassContainerPath },
          args: [
            '-h',
            '/var/run/postgresql',
            '-p',
            '5432',
            '-U',
            input.sourceRole,
            '-d',
            input.sourceDatabase,
            '-Fc',
            '--no-owner',
            '--no-privileges',
            '--lock-wait-timeout=5s',
            '-f',
            `/nf04-output/${partialName}`,
          ],
        },
        operationDeadline.signal,
      );
    } catch {
      operationDeadline.dispose();
      throw archiveOperationStopped({
        operationSignal: operationDeadline.signal,
        deadlineExpired: operationDeadline.expired,
      });
    }
    try {
      const observedIdentity = execution.identity;
      const identity: Nf04ContainerExecIdentity = {
        containerId: observedIdentity.containerId,
        execId: observedIdentity.execId,
      };
      assertExactExecutionIdentity(execution, identity, input.sourceContainerId);
      const dump: Nf04ContainerExecExit = await this.writerMonitor.waitForCompletion({
        execution,
        identity,
        partialPath,
        maximumBytes,
        operationSignal: operationDeadline.signal,
        deadlineExpired: operationDeadline.expired,
      });
      if (dump.exitCode !== 0) {
        throw new Nf04ArchiveError('pg_dump did not complete successfully');
      }

      throwIfArchiveOperationStopped(operationDeadline);
      const partial = await readStableArchive(input.artifactRoot, partialPath);
      if (
        partial.byteSize <= 0 ||
        priorArchiveBytes + partial.byteSize > NF04_TOTAL_ARCHIVE_LIMIT_BYTES
      ) {
        throw new Nf04ArchiveError('Partial archive violates the bounded file contract');
      }
      const publishPartial = partial.boundary;
      assertStableArchiveBoundary(initialPartialBoundary, publishPartial);
      const listedDigest = partial.sha256;
      throwIfArchiveOperationStopped(operationDeadline);
      assertTrustedRootIdentity(initialPartialBoundary, await assertNf04TrustedArtifactRoot(input));
      assertStableArchiveBoundary(
        initialFinalBoundary,
        await assertNf04PathOwnedByRoot(input.artifactRoot, finalPath, 'absent'),
      );
      throwIfArchiveOperationStopped(operationDeadline);
      const listing = await this.listingRunner.run({
        executable: 'docker',
        args: [
          'exec',
          '-e',
          `PGPASSFILE=${input.pgPassContainerPath}`,
          input.sourceContainerId,
          'pg_restore',
          '--list',
          `/nf04-output/${partialName}`,
        ],
        timeoutMs: input.timeoutMs,
        signal: operationDeadline.signal,
      });
      if (listing.timedOut || listing.exitCode !== 0) {
        throw new Nf04ArchiveError('Partial archive table of contents is unreadable');
      }

      const listed = await readStableArchive(input.artifactRoot, partialPath);
      const listedPartial = listed.boundary;
      assertStableArchiveBoundary(initialPartialBoundary, listedPartial);
      assertSameArchiveFile(
        publishPartial,
        listedPartial,
        'Archive partial changed during table-of-contents validation',
      );
      if (listed.sha256 !== listedDigest || listed.byteSize !== partial.byteSize) {
        throw new Nf04ArchiveError('Archive partial changed during table-of-contents validation');
      }

      // The injected publication port must provide same-directory, no-clobber
      // publication while bound to the captured root/parent/file identities.
      assertTrustedRootIdentity(initialPartialBoundary, await assertNf04TrustedArtifactRoot(input));
      const stablePartial = await assertNf04PathOwnedByRoot(
        input.artifactRoot,
        partialPath,
        'file',
      );
      assertStableArchiveBoundary(initialPartialBoundary, stablePartial);
      assertSameArchiveFile(
        publishPartial,
        stablePartial,
        'Archive partial changed during table-of-contents validation',
      );
      assertStableArchiveBoundary(
        initialFinalBoundary,
        await assertNf04PathOwnedByRoot(input.artifactRoot, finalPath, 'absent'),
      );
      throwIfArchiveOperationStopped(operationDeadline);
      if (!stablePartial.targetIdentity) {
        throw new Nf04ArchiveError('Archive partial identity is unavailable for publication');
      }
      await this.publicationPort.publish({
        artifactRoot: input.artifactRoot,
        partialPath,
        finalPath,
        rootIdentity: stablePartial.rootIdentity,
        parentIdentity: stablePartial.parentIdentity,
        partialIdentity: stablePartial.targetIdentity,
        signal: operationDeadline.signal,
      });
      throwIfArchiveOperationStopped(operationDeadline);
      const published = await assertNf04PathOwnedByRoot(input.artifactRoot, finalPath, 'file');
      assertStableArchiveBoundary(initialFinalBoundary, published);
      assertSameArchiveFile(
        stablePartial,
        published,
        'Published archive does not match the monitored partial',
      );
      await assertNf04ArchivePathAbsent(partialPath);
      const stablePublished = await assertNf04PathOwnedByRoot(
        input.artifactRoot,
        finalPath,
        'file',
      );
      assertStableArchiveBoundary(initialFinalBoundary, stablePublished);
      assertSameArchiveFile(published, stablePublished, 'Published archive changed after handoff');
      throwIfArchiveOperationStopped(operationDeadline);
      assertTrustedRootIdentity(initialFinalBoundary, await assertNf04TrustedArtifactRoot(input));
      throwIfArchiveOperationStopped(operationDeadline);
      const final = await readStableArchive(input.artifactRoot, finalPath);
      if (final.sha256 !== listedDigest || final.byteSize !== partial.byteSize) {
        throw new Nf04ArchiveError('Archive content changed after table-of-contents validation');
      }
      throwIfArchiveOperationStopped(operationDeadline);
      const finalBoundary = final.boundary;
      assertStableArchiveBoundary(initialFinalBoundary, finalBoundary);
      assertSameArchiveFile(stablePublished, finalBoundary, 'Published archive changed while read');
      throwIfArchiveOperationStopped(operationDeadline);
      return {
        fileName: finalName,
        byteSize: final.byteSize,
        sha256: final.sha256,
        completedAt: this.now().toISOString(),
        listedWithPgRestore: true,
      };
    } finally {
      operationDeadline.dispose();
    }
  }

  async verify(input: {
    repositoryRoot: string;
    artifactRoot: string;
    runId: string;
    evidence: Pick<Nf04ArchiveEvidence, 'fileName' | 'byteSize' | 'sha256'>;
  }): Promise<void> {
    const { artifactRoot, evidence } = input;
    const trustedRootIdentity = await assertNf04TrustedArtifactRoot(input);
    if (basename(evidence.fileName) !== evidence.fileName) {
      throw new Nf04ArchiveError('Archive evidence contains a non-canonical file name');
    }
    const archivePath = join(artifactRoot, evidence.fileName);
    const actual = await readStableArchive(artifactRoot, archivePath);
    const verified = actual.boundary;
    assertTrustedRootIdentity(verified, trustedRootIdentity);
    if (actual.byteSize !== evidence.byteSize) {
      throw new Nf04ArchiveError('Archive size does not match fixed evidence');
    }
    if (actual.sha256 !== evidence.sha256) {
      throw new Nf04ArchiveError('Archive digest does not match fixed evidence');
    }
    assertTrustedRootIdentity(verified, await assertNf04TrustedArtifactRoot(input));
    const stable = await readStableArchive(artifactRoot, archivePath);
    assertStableArchiveBoundary(verified, stable.boundary);
    assertSameArchiveFile(
      verified,
      stable.boundary,
      'Archive changed while fixed evidence was verified',
    );
    if (stable.byteSize !== evidence.byteSize || stable.sha256 !== evidence.sha256) {
      throw new Nf04ArchiveError('Archive evidence changed during verification');
    }
  }

  private async verifyPriorArchive(input: {
    kind: Nf04ArchiveKind;
    repositoryRoot: string;
    artifactRoot: string;
    runId: string;
    priorArchive?: Nf04ArchiveEvidence;
  }): Promise<number> {
    if (input.kind === 'pre-delete') {
      if (input.priorArchive) {
        throw new Nf04ArchiveError('Pre-delete archive cannot declare a prior archive');
      }
      return 0;
    }
    if (!input.priorArchive || input.priorArchive.fileName !== 'pre-delete.dump') {
      throw new Nf04ArchiveError('Post-delete archive requires fixed pre-delete evidence');
    }
    await this.verify({
      repositoryRoot: input.repositoryRoot,
      artifactRoot: input.artifactRoot,
      runId: input.runId,
      evidence: input.priorArchive,
    });
    return input.priorArchive.byteSize;
  }
}

export async function assertNf04ArchivePathAbsent(
  path: string,
  probe: (path: string) => Promise<void> = access,
): Promise<void> {
  try {
    await probe(path);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return;
    throw new Nf04ArchiveError('Archive path availability could not be confirmed');
  }
  throw new Nf04ArchiveError('Archive path already exists');
}

function assertStableArchiveBoundary(
  initial: Nf04PathOwnershipSnapshot,
  current: Nf04PathOwnershipSnapshot,
): void {
  if (
    initial.rootPath !== current.rootPath ||
    initial.rootRealPath !== current.rootRealPath ||
    initial.rootIdentity.device !== current.rootIdentity.device ||
    initial.rootIdentity.inode !== current.rootIdentity.inode ||
    initial.parentPath !== current.parentPath ||
    initial.parentRealPath !== current.parentRealPath ||
    initial.parentIdentity.device !== current.parentIdentity.device ||
    initial.parentIdentity.inode !== current.parentIdentity.inode ||
    initial.targetPath !== current.targetPath
  ) {
    throw new Nf04ArchiveError('Archive filesystem boundary changed during creation');
  }
}

function assertSameArchiveFile(
  expected: Nf04PathOwnershipSnapshot,
  actual: Nf04PathOwnershipSnapshot,
  message: string,
): void {
  if (
    !expected.targetIdentity ||
    !actual.targetIdentity ||
    expected.targetIdentity.device !== actual.targetIdentity.device ||
    expected.targetIdentity.inode !== actual.targetIdentity.inode
  ) {
    throw new Nf04ArchiveError(message);
  }
}

function assertTrustedRootIdentity(
  boundary: Nf04PathOwnershipSnapshot,
  trustedRoot: Nf04FilesystemIdentity,
): void {
  if (
    boundary.rootIdentity.device !== trustedRoot.device ||
    boundary.rootIdentity.inode !== trustedRoot.inode
  ) {
    throw new Nf04ArchiveError('Archive trusted root identity changed during operation');
  }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function settleStart(start: Promise<void>): Promise<WriterLifecycleEvent> {
  return start.then(
    () => ({ status: 'started' }),
    () => ({ status: 'unconfirmed' }),
  );
}

function settleExit(exit: Promise<Nf04ContainerExecExit>): Promise<WriterLifecycleEvent> {
  return exit.then(
    (result) => ({ status: 'completed', result }),
    () => ({ status: 'unconfirmed' }),
  );
}

function waitForWriterEvent(
  lifecycle: Promise<WriterLifecycleEvent>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<WriterLifecycleEvent | typeof POLL | typeof ABORTED> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (value: WriterLifecycleEvent | typeof POLL | typeof ABORTED) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      resolve(value);
    };
    const abort = () => finish(ABORTED);
    const timeout = setTimeout(() => finish(POLL), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    void lifecycle.then(finish);
  });
}

function assertExactExecutionIdentity(
  execution: Nf04ContainerExecution,
  expected: Nf04ContainerExecIdentity,
  requiredContainerId: string = expected.containerId,
): void {
  const actual = execution.identity;
  if (
    expected.containerId !== requiredContainerId ||
    expected.execId.trim().length === 0 ||
    actual.containerId !== expected.containerId ||
    actual.execId !== expected.execId
  ) {
    throw new Nf04ArchiveError('Archive writer identity could not be confirmed');
  }
}

function archiveOperationStopReason(
  input: Pick<Nf04ArchiveWriterMonitorInput, 'deadlineExpired'>,
): ArchiveStopReason {
  return input.deadlineExpired()
    ? 'Archive writer exceeded its operation deadline'
    : 'Archive writer was cancelled';
}

function archiveOperationStopped(
  input: Pick<Nf04ArchiveWriterMonitorInput, 'operationSignal' | 'deadlineExpired'>,
): Nf04ArchiveError {
  if (input.deadlineExpired()) {
    return new Nf04ArchiveError('Archive writer exceeded its operation deadline');
  }
  if (input.operationSignal.aborted) {
    return new Nf04ArchiveError('Archive writer was cancelled');
  }
  return new Nf04ArchiveError('Archive writer could not be allocated safely');
}

function throwIfArchiveOperationStopped(
  deadline: Readonly<{
    signal: AbortSignal;
    expired(): boolean;
  }>,
): void {
  if (deadline.signal.aborted)
    throw archiveOperationStopped({
      operationSignal: deadline.signal,
      deadlineExpired: deadline.expired,
    });
}

function createDeadline(
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Readonly<{
  signal: AbortSignal;
  expired(): boolean;
  dispose(): void;
}> {
  if (timeoutMs <= 0) throw new Nf04ArchiveError('Archive operation timeout must be positive');
  const controller = new AbortController();
  let expired = false;
  const onParentAbort = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  const timeout = setTimeout(() => {
    expired = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    expired: () => expired,
    dispose: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', onParentAbort);
    },
  };
}

async function readStableArchive(
  artifactRoot: string,
  path: string,
): Promise<
  Readonly<{
    boundary: Nf04PathOwnershipSnapshot;
    byteSize: number;
    sha256: string;
  }>
> {
  const boundary = await assertNf04PathOwnedByRoot(artifactRoot, path, 'file');
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      !boundary.targetIdentity ||
      boundary.targetIdentity.device !== opened.dev ||
      boundary.targetIdentity.inode !== opened.ino ||
      opened.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new Nf04ArchiveError('Archive file identity could not be held stable for reading');
    }
    const sha256 = await sha256Handle(handle);
    const current = await assertNf04PathOwnedByRoot(artifactRoot, path, 'file');
    assertStableArchiveBoundary(boundary, current);
    assertSameArchiveFile(boundary, current, 'Archive file changed while it was read');
    return { boundary: current, byteSize: Number(opened.size), sha256 };
  } finally {
    await handle.close();
  }
}

function sha256Handle(handle: FileHandle): Promise<string> {
  return new Promise((resolve, reject) => {
    const digest = createHash('sha256');
    const input = handle.createReadStream({ autoClose: false, start: 0 });
    input.on('data', (chunk) => digest.update(chunk));
    input.once('error', reject);
    input.once('end', () => resolve(digest.digest('hex')));
  });
}
