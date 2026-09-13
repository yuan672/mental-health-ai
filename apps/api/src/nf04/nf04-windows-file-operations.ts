import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, parse, resolve } from 'node:path';
import { Nf04ArchiveError, type Nf04ArchivePublicationPort } from './nf04-archive';
import type { Nf04FilesystemIdentity } from './nf04-guards';

const MAX_HELPER_OUTPUT_BYTES = 4 * 1024;
const HELPER_TERMINATION_GRACE_MS = 1_000;
const MAX_UINT64 = (1n << 64n) - 1n;

type Nf04WindowsFileOperation = 'publish' | 'delete';

type Nf04WindowsFileOperationResult = Readonly<{
  version: 1;
  status: 'completed' | 'rejected' | 'unknown';
  code: 'COMPLETED' | 'TARGET_EXISTS' | 'BOUNDARY_REJECTED' | 'MUTATION_UNKNOWN';
}>;

type Nf04WindowsFileOperationRequest = Readonly<{
  operation: Nf04WindowsFileOperation;
  rootPath: string;
  parentPath: string;
  sourcePath: string;
  targetName?: string;
  rootIdentity: Nf04FilesystemIdentity;
  parentIdentity: Nf04FilesystemIdentity;
  sourceIdentity: Nf04FilesystemIdentity;
  signal: AbortSignal;
  timeoutMs: number;
}>;

export type Nf04StableFileCleanupInput = Readonly<{
  artifactRoot: string;
  targetPath: string;
  rootIdentity: Nf04FilesystemIdentity;
  parentIdentity: Nf04FilesystemIdentity;
  targetIdentity: Nf04FilesystemIdentity;
  signal: AbortSignal;
}>;

export interface Nf04StableFileCleanupPort {
  delete(input: Nf04StableFileCleanupInput): Promise<void>;
}

export class Nf04WindowsFileOperationUnknownError extends Nf04ArchiveError {
  constructor(message: string) {
    super(message);
    this.name = Nf04WindowsFileOperationUnknownError.name;
  }
}

export class WindowsNf04ArchivePublicationAdapter implements Nf04ArchivePublicationPort {
  constructor(private readonly timeoutMs = 5_000) {
    assertPositiveTimeout(timeoutMs);
  }

  async publish(input: Parameters<Nf04ArchivePublicationPort['publish']>[0]): Promise<void> {
    assertWindowsRuntime();
    const rootPath = resolve(input.artifactRoot);
    const partialPath = assertExactChild(rootPath, input.partialPath);
    const finalPath = assertExactChild(rootPath, input.finalPath);
    const partialName = basename(partialPath);
    const finalName = basename(finalPath);
    if (!(
      (partialName === '.pre-delete.dump.partial' && finalName === 'pre-delete.dump') ||
      (partialName === '.post-delete.dump.partial' && finalName === 'post-delete.dump')
    )) {
      throw new Nf04ArchiveError('Archive publication names are outside the fixed contract');
    }
    assertIdentity(input.rootIdentity);
    assertIdentity(input.parentIdentity);
    assertIdentity(input.partialIdentity);
    assertOperationCanStart(input.signal, 'Archive publication');

    const result = await invokeWindowsFileOperation({
      operation: 'publish',
      rootPath,
      parentPath: dirname(partialPath),
      sourcePath: partialPath,
      targetName: finalName,
      rootIdentity: input.rootIdentity,
      parentIdentity: input.parentIdentity,
      sourceIdentity: input.partialIdentity,
      signal: input.signal,
      timeoutMs: this.timeoutMs,
    });
    assertCompleted(result, 'Archive publication');
  }
}

export class WindowsNf04StableFileCleanupAdapter implements Nf04StableFileCleanupPort {
  constructor(private readonly timeoutMs = 5_000) {
    assertPositiveTimeout(timeoutMs);
  }

  async delete(input: Nf04StableFileCleanupInput): Promise<void> {
    assertWindowsRuntime();
    const rootPath = resolve(input.artifactRoot);
    const targetPath = assertExactChild(rootPath, input.targetPath);
    assertIdentity(input.rootIdentity);
    assertIdentity(input.parentIdentity);
    assertIdentity(input.targetIdentity);
    assertOperationCanStart(input.signal, 'Protected file cleanup');

    const result = await invokeWindowsFileOperation({
      operation: 'delete',
      rootPath,
      parentPath: dirname(targetPath),
      sourcePath: targetPath,
      rootIdentity: input.rootIdentity,
      parentIdentity: input.parentIdentity,
      sourceIdentity: input.targetIdentity,
      signal: input.signal,
      timeoutMs: this.timeoutMs,
    });
    assertCompleted(result, 'Protected file cleanup');
  }
}

async function invokeWindowsFileOperation(
  request: Nf04WindowsFileOperationRequest,
): Promise<Nf04WindowsFileOperationResult> {
  const helperPath = await resolveHelperPath();
  assertOperationCanStart(request.signal, 'Protected filesystem operation');
  const args = buildHelperArguments(helperPath, request);

  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = '';
    let outputBytes = 0;
    let interrupted = false;
    let settled = false;
    let terminationTimer: NodeJS.Timeout | undefined;
    const child = spawn('powershell.exe', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (result: Nf04WindowsFileOperationResult | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (terminationTimer) clearTimeout(terminationTimer);
      request.signal.removeEventListener('abort', interrupt);
      if (result instanceof Error) rejectPromise(result);
      else resolvePromise(result);
    };
    const unknown = () =>
      finish(
        new Nf04WindowsFileOperationUnknownError(
          'Protected filesystem mutation outcome is unknown; the artifact remains quarantined',
        ),
      );
    const interrupt = () => {
      if (interrupted) return;
      interrupted = true;
      child.kill();
      terminationTimer = setTimeout(unknown, HELPER_TERMINATION_GRACE_MS);
      terminationTimer.unref();
    };
    const timeout = setTimeout(interrupt, request.timeoutMs);
    timeout.unref();
    request.signal.addEventListener('abort', interrupt, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_HELPER_OUTPUT_BYTES) {
        interrupt();
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_HELPER_OUTPUT_BYTES) interrupt();
    });
    child.once('error', unknown);
    child.once('close', (exitCode) => {
      if (interrupted || exitCode !== 0) {
        unknown();
        return;
      }
      try {
        finish(parseHelperResult(stdout));
      } catch {
        unknown();
      }
    });
  });
}

function buildHelperArguments(
  helperPath: string,
  request: Nf04WindowsFileOperationRequest,
): string[] {
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    helperPath,
    '-Operation',
    request.operation,
    '-RootPath',
    request.rootPath,
    '-ParentPath',
    request.parentPath,
    '-SourcePath',
    request.sourcePath,
    ...(request.targetName ? ['-TargetName', request.targetName] : []),
    '-ExpectedRootDevice',
    request.rootIdentity.device.toString(),
    '-ExpectedRootInode',
    request.rootIdentity.inode.toString(),
    '-ExpectedParentDevice',
    request.parentIdentity.device.toString(),
    '-ExpectedParentInode',
    request.parentIdentity.inode.toString(),
    '-ExpectedSourceDevice',
    request.sourceIdentity.device.toString(),
    '-ExpectedSourceInode',
    request.sourceIdentity.inode.toString(),
  ];
}

function parseHelperResult(output: string): Nf04WindowsFileOperationResult {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) throw new Error('invalid helper output');
  const value: unknown = JSON.parse(lines[0]!);
  if (!value || typeof value !== 'object') throw new Error('invalid helper output');
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (keys.join(',') !== 'code,status,version' || candidate.version !== 1) {
    throw new Error('invalid helper output');
  }
  if (
    candidate.status !== 'completed' &&
    candidate.status !== 'rejected' &&
    candidate.status !== 'unknown'
  ) {
    throw new Error('invalid helper output');
  }
  if (
    candidate.code !== 'COMPLETED' &&
    candidate.code !== 'TARGET_EXISTS' &&
    candidate.code !== 'BOUNDARY_REJECTED' &&
    candidate.code !== 'MUTATION_UNKNOWN'
  ) {
    throw new Error('invalid helper output');
  }
  return candidate as Nf04WindowsFileOperationResult;
}

function assertCompleted(result: Nf04WindowsFileOperationResult, operation: string): void {
  if (result.status === 'completed' && result.code === 'COMPLETED') return;
  if (result.status === 'unknown' || result.code === 'MUTATION_UNKNOWN') {
    throw new Nf04WindowsFileOperationUnknownError(
      `${operation} outcome is unknown; the artifact remains quarantined`,
    );
  }
  if (result.code === 'TARGET_EXISTS') {
    throw new Nf04ArchiveError(`${operation} refused to overwrite an existing target`);
  }
  throw new Nf04ArchiveError(`${operation} rejected the protected filesystem boundary`);
}

async function resolveHelperPath(): Promise<string> {
  let current = resolve(__dirname);
  while (true) {
    const workspaceMarker = resolve(current, 'pnpm-workspace.yaml');
    try {
      await access(workspaceMarker, constants.R_OK);
      const helperPath = resolve(current, 'scripts', 'nf04', 'windows-archive-file-ops.ps1');
      const [stats, canonical] = await Promise.all([lstat(helperPath), realpath(helperPath)]);
      if (
        !stats.isFile() ||
        stats.isSymbolicLink() ||
        canonical.toLowerCase() !== helperPath.toLowerCase()
      ) {
        throw new Nf04ArchiveError('The fixed Windows filesystem helper is not a real file');
      }
      return helperPath;
    } catch (error) {
      if (error instanceof Nf04ArchiveError) throw error;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Nf04ArchiveError('The fixed Windows filesystem helper is unavailable');
    }
    current = parent;
  }
}

function assertExactChild(rootPath: string, candidate: string): string {
  if (!isAbsolute(candidate)) {
    throw new Nf04ArchiveError('Protected filesystem paths must be absolute');
  }
  const resolvedCandidate = resolve(candidate);
  if (dirname(resolvedCandidate).toLowerCase() !== rootPath.toLowerCase()) {
    throw new Nf04ArchiveError('Protected filesystem target is not an exact artifact child');
  }
  if (parse(rootPath).root.toLowerCase() !== parse(resolvedCandidate).root.toLowerCase()) {
    throw new Nf04ArchiveError('Protected filesystem operation crosses a volume boundary');
  }
  if (rootPath.startsWith('\\\\')) {
    throw new Nf04ArchiveError('Protected filesystem operations require a local fixed volume');
  }
  return resolvedCandidate;
}

function assertIdentity(identity: Nf04FilesystemIdentity): void {
  if (
    identity.device < 0n ||
    identity.device > MAX_UINT64 ||
    identity.inode < 0n ||
    identity.inode > MAX_UINT64
  ) {
    throw new Nf04ArchiveError('Protected filesystem identity is outside the supported range');
  }
}

function assertOperationCanStart(signal: AbortSignal, operation: string): void {
  if (signal.aborted) throw new Nf04ArchiveError(`${operation} was cancelled before dispatch`);
}

function assertWindowsRuntime(): void {
  if (process.platform !== 'win32') {
    throw new Nf04ArchiveError('The stable archive filesystem adapter requires Windows');
  }
}

function assertPositiveTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Nf04ArchiveError('Protected filesystem operation timeout must be positive');
  }
}
