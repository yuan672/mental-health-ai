import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import type { Pool } from '@mental-health/database';
import {
  deriveNf04ExpectedNames,
  isPathWithin,
  NF04_ARTIFACT_ROOT_NAME,
  type Nf04Manifest,
} from './nf04-contract';

export class Nf04GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = Nf04GuardError.name;
  }
}

export type Nf04ResourcePresence = Readonly<{
  containerNames: ReadonlySet<string>;
  volumeNames: ReadonlySet<string>;
  networkNames: ReadonlySet<string>;
}>;

export type Nf04DatabaseIdentity = Readonly<{
  databaseName: string;
  databaseOid: number;
  systemIdentifier: string;
  currentUser: string;
}>;

export type Nf04FilesystemIdentity = Readonly<{
  device: bigint;
  inode: bigint;
}>;

export type Nf04PathOwnershipSnapshot = Readonly<{
  rootPath: string;
  rootRealPath: string;
  rootIdentity: Nf04FilesystemIdentity;
  parentPath: string;
  parentRealPath: string;
  parentIdentity: Nf04FilesystemIdentity;
  targetPath: string;
  targetRealPath?: string;
  targetIdentity?: Nf04FilesystemIdentity;
}>;

const DOCKER_DESKTOP_WINDOWS_MOUNT_PREFIX = '/run/desktop/mnt/host/';

type Nf04ProtectedFileInput = Readonly<{
  repositoryRoot: string;
  artifactRoot: string;
  candidatePath: string;
}>;

export function assertNf04ManifestBoundary(manifest: Nf04Manifest): void {
  const expected = deriveNf04ExpectedNames(manifest.runId);
  const canonicalRepositoryRoot = resolve(manifest.repositoryRoot);
  const canonicalArtifactRoot = resolve(manifest.artifactRoot);
  const exactArtifactRoot = resolve(
    dirname(canonicalRepositoryRoot),
    'handoff',
    NF04_ARTIFACT_ROOT_NAME,
    manifest.runId,
  );
  if (canonicalArtifactRoot !== exactArtifactRoot) {
    throw new Nf04GuardError('Artifact root is not an exact child of the NF-04 artifact directory');
  }
  if (basename(canonicalArtifactRoot) !== manifest.runId) {
    throw new Nf04GuardError('Artifact root does not match the exact run ID');
  }
  if (
    canonicalArtifactRoot === canonicalRepositoryRoot ||
    isPathWithin(canonicalRepositoryRoot, canonicalArtifactRoot)
  ) {
    throw new Nf04GuardError('NF-04 artifacts and secrets must remain outside the repository');
  }
  if (manifest.archivesRoot) {
    const exactArchivesRoot = resolve(canonicalArtifactRoot, 'archives');
    if (resolve(manifest.archivesRoot) !== exactArchivesRoot) {
      throw new Nf04GuardError('Archive root must be the exact archives child of this run');
    }
  }
  const exactSecretsRoot = manifest.archivesRoot
    ? resolve(canonicalArtifactRoot, 'secrets')
    : canonicalArtifactRoot;
  for (const secretPath of Object.values(manifest.files).filter(
    (value): value is string => typeof value === 'string',
  )) {
    if (!isPathWithin(exactSecretsRoot, secretPath)) {
      throw new Nf04GuardError('Every secret path must remain inside the exact run secrets root');
    }
  }

  const observed = manifest.observed;
  if (observed.sourceContainer && observed.sourceContainer.name !== expected.sourceContainer) {
    throw new Nf04GuardError('Observed source container name does not match this run');
  }
  if (observed.restoreContainer && observed.restoreContainer.name !== expected.restoreContainer) {
    throw new Nf04GuardError('Observed restore container name does not match this run');
  }
  if (observed.sourceVolume && observed.sourceVolume.name !== expected.sourceVolume) {
    throw new Nf04GuardError('Observed source volume name does not match this run');
  }
  if (observed.restoreVolume && observed.restoreVolume.name !== expected.restoreVolume) {
    throw new Nf04GuardError('Observed restore volume name does not match this run');
  }
  if (observed.network && observed.network.name !== expected.network) {
    throw new Nf04GuardError('Observed network name does not match this run');
  }
  if (observed.sourceDatabase && observed.sourceDatabase.name !== expected.sourceDatabase) {
    throw new Nf04GuardError('Observed source database name does not match this run');
  }
}

export async function assertNf04PathOwnedByRoot(
  artifactRoot: string,
  targetPath: string,
  expectation: 'absent' | 'file',
): Promise<Nf04PathOwnershipSnapshot> {
  const artifactPath = resolve(artifactRoot);
  const candidatePath = resolve(targetPath);

  if (!isPathWithin(artifactPath, candidatePath)) {
    throw new Nf04GuardError('NF-04 filesystem target must remain inside the artifact root');
  }

  const [artifactStats, artifactRealPath] = await Promise.all([
    lstat(artifactPath, { bigint: true }),
    realpath(artifactPath),
  ]);
  if (!artifactStats.isDirectory() || artifactStats.isSymbolicLink()) {
    throw new Nf04GuardError('NF-04 artifact root must be a real directory');
  }

  const parentPath = dirname(candidatePath);
  const parentStats = await lstat(parentPath, { bigint: true });
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    throw new Nf04GuardError('NF-04 filesystem target parent must be a real directory');
  }
  const parentRealPath = await realpath(parentPath);
  if (parentRealPath !== artifactRealPath && !isPathWithin(artifactRealPath, parentRealPath)) {
    throw new Nf04GuardError('NF-04 filesystem target parent escapes the real artifact root');
  }

  const candidateStats = await lstatIfExists(candidatePath);
  let candidateRealPath: string | undefined;

  if (expectation === 'absent') {
    if (candidateStats) {
      throw new Nf04GuardError('NF-04 filesystem target must not already exist');
    }
  } else {
    if (!candidateStats) {
      throw new Nf04GuardError('NF-04 protected file does not exist');
    }
    if (!candidateStats.isFile() || candidateStats.isSymbolicLink()) {
      throw new Nf04GuardError('NF-04 protected path must be a real regular file');
    }
    candidateRealPath = await realpath(candidatePath);
    if (!isPathWithin(artifactRealPath, candidateRealPath)) {
      throw new Nf04GuardError('NF-04 protected file escapes the real artifact root');
    }
  }

  const [stableArtifactStats, stableArtifactRealPath, stableParentStats, stableParentRealPath] =
    await Promise.all([
      lstat(artifactPath, { bigint: true }),
      realpath(artifactPath),
      lstat(parentPath, { bigint: true }),
      realpath(parentPath),
    ]);
  if (
    !hasSameFilesystemIdentity(artifactStats, stableArtifactStats) ||
    artifactRealPath !== stableArtifactRealPath
  ) {
    throw new Nf04GuardError('NF-04 artifact root changed during validation');
  }
  if (
    !hasSameFilesystemIdentity(parentStats, stableParentStats) ||
    parentRealPath !== stableParentRealPath
  ) {
    throw new Nf04GuardError('NF-04 filesystem target parent changed during validation');
  }
  const stableCandidateStats = await lstatIfExists(candidatePath);
  if (expectation === 'absent') {
    if (stableCandidateStats) {
      throw new Nf04GuardError('NF-04 filesystem target appeared during validation');
    }
  } else if (
    !candidateStats ||
    !stableCandidateStats ||
    !hasSameFilesystemIdentity(candidateStats, stableCandidateStats) ||
    candidateRealPath !== (await realpath(candidatePath))
  ) {
    throw new Nf04GuardError('NF-04 protected file changed during validation');
  }

  return {
    rootPath: artifactPath,
    rootRealPath: artifactRealPath,
    rootIdentity: toFilesystemIdentity(artifactStats),
    parentPath,
    parentRealPath,
    parentIdentity: toFilesystemIdentity(parentStats),
    targetPath: candidatePath,
    ...(candidateRealPath ? { targetRealPath: candidateRealPath } : {}),
    ...(candidateStats ? { targetIdentity: toFilesystemIdentity(candidateStats) } : {}),
  };
}

export async function assertNf04TrustedArtifactRoot(input: {
  repositoryRoot: string;
  artifactRoot: string;
  runId: string;
}): Promise<Nf04FilesystemIdentity> {
  if (!/^\d{8}-\d{6}-[a-f0-9]{8}$/.test(input.runId)) {
    throw new Nf04GuardError('NF-04 run ID is invalid');
  }
  const repositoryPath = resolve(input.repositoryRoot);
  const artifactPath = resolve(input.artifactRoot);
  const expectedArtifactPath = resolve(
    dirname(repositoryPath),
    'handoff',
    NF04_ARTIFACT_ROOT_NAME,
    input.runId,
  );
  if (artifactPath !== expectedArtifactPath) {
    throw new Nf04GuardError('NF-04 artifact root is not the exact task run directory');
  }
  const [repositoryStats, repositoryRealPath, artifactStats, artifactRealPath] = await Promise.all([
    lstat(repositoryPath, { bigint: true }),
    realpath(repositoryPath),
    lstat(artifactPath, { bigint: true }),
    realpath(artifactPath),
  ]);
  if (
    !repositoryStats.isDirectory() ||
    repositoryStats.isSymbolicLink() ||
    !artifactStats.isDirectory() ||
    artifactStats.isSymbolicLink()
  ) {
    throw new Nf04GuardError('NF-04 repository and artifact roots must be real directories');
  }
  if (
    artifactRealPath === repositoryRealPath ||
    isPathWithin(repositoryRealPath, artifactRealPath) ||
    isPathWithin(artifactRealPath, repositoryRealPath)
  ) {
    throw new Nf04GuardError('NF-04 real artifact root must remain outside the repository');
  }
  return toFilesystemIdentity(artifactStats);
}

export async function assertNf04TrustedArchiveRoot(input: {
  repositoryRoot: string;
  artifactRoot: string;
  archivesRoot: string;
  runId: string;
}): Promise<Nf04FilesystemIdentity> {
  await assertNf04TrustedArtifactRoot({
    repositoryRoot: input.repositoryRoot,
    artifactRoot: input.artifactRoot,
    runId: input.runId,
  });
  const runRoot = resolve(input.artifactRoot);
  const archivesRoot = resolve(input.archivesRoot);
  if (archivesRoot !== resolve(runRoot, 'archives')) {
    throw new Nf04GuardError('NF-04 archive root is not the exact run archives directory');
  }
  const [runStats, runRealPath, archiveStats, archiveRealPath] = await Promise.all([
    lstat(runRoot, { bigint: true }),
    realpath(runRoot),
    lstat(archivesRoot, { bigint: true }),
    realpath(archivesRoot),
  ]);
  if (
    !runStats.isDirectory() ||
    runStats.isSymbolicLink() ||
    !archiveStats.isDirectory() ||
    archiveStats.isSymbolicLink() ||
    !isPathWithin(runRealPath, archiveRealPath)
  ) {
    throw new Nf04GuardError('NF-04 archives directory is not a real child of the run root');
  }
  const [stableRunStats, stableRunRealPath, stableArchiveStats, stableArchiveRealPath] =
    await Promise.all([
      lstat(runRoot, { bigint: true }),
      realpath(runRoot),
      lstat(archivesRoot, { bigint: true }),
      realpath(archivesRoot),
    ]);
  if (
    !hasSameFilesystemIdentity(runStats, stableRunStats) ||
    runRealPath !== stableRunRealPath ||
    !hasSameFilesystemIdentity(archiveStats, stableArchiveStats) ||
    archiveRealPath !== stableArchiveRealPath
  ) {
    throw new Nf04GuardError('NF-04 archive root changed during validation');
  }
  return toFilesystemIdentity(archiveStats);
}

export async function readNf04ProtectedFile(input: Nf04ProtectedFileInput): Promise<string> {
  const boundary = await assertNf04PathOwnedByRoot(input.artifactRoot, input.candidatePath, 'file');
  const repositoryRealPath = await realpath(resolve(input.repositoryRoot));
  if (
    boundary.rootRealPath === repositoryRealPath ||
    isPathWithin(repositoryRealPath, boundary.rootRealPath) ||
    isPathWithin(boundary.rootRealPath, repositoryRealPath)
  ) {
    throw new Nf04GuardError('NF-04 real artifact root must remain outside the repository');
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(boundary.targetPath, constants.O_RDONLY | noFollow);
  try {
    const openedFileIdentity = await handle.stat({ bigint: true });
    const pathIdentity = await lstat(boundary.targetPath, { bigint: true });
    const parentIdentity = await lstat(boundary.parentPath, { bigint: true });
    const rootIdentity = await lstat(boundary.rootPath, { bigint: true });
    if (
      !openedFileIdentity.isFile() ||
      pathIdentity.isSymbolicLink() ||
      !hasSameFilesystemIdentityValue(boundary.targetIdentity, openedFileIdentity) ||
      !hasSameFilesystemIdentityValue(boundary.targetIdentity, pathIdentity) ||
      !hasSameFilesystemIdentityValue(boundary.parentIdentity, parentIdentity) ||
      !hasSameFilesystemIdentityValue(boundary.rootIdentity, rootIdentity) ||
      boundary.parentRealPath !== (await realpath(boundary.parentPath)) ||
      boundary.rootRealPath !== (await realpath(boundary.rootPath))
    ) {
      throw new Nf04GuardError('NF-04 protected file identity changed during validation');
    }
    if (process.platform !== 'win32' && (openedFileIdentity.mode & 0o077n) !== 0n) {
      throw new Nf04GuardError('NF-04 fixture secret file permissions are too broad');
    }
    return await handle.readFile({ encoding: 'utf8' });
  } finally {
    await handle.close();
  }
}

function hasSameFilesystemIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function hasSameFilesystemIdentityValue(
  left: Nf04FilesystemIdentity | undefined,
  right: BigIntStats,
): boolean {
  return left?.device === right.dev && left.inode === right.ino;
}

function toFilesystemIdentity(stats: BigIntStats): Nf04FilesystemIdentity {
  return { device: stats.dev, inode: stats.ino };
}

async function lstatIfExists(path: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error;
    return undefined;
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

export function assertNf04PlannedResourcesAbsent(
  manifest: Nf04Manifest,
  presence: Nf04ResourcePresence,
): void {
  if (manifest.state !== 'planned') {
    throw new Nf04GuardError('Planned-resource guard requires the planned state');
  }
  assertNf04ManifestBoundary(manifest);
  const expected = deriveNf04ExpectedNames(manifest.runId);
  const collisions = [
    presence.containerNames.has(expected.sourceContainer) ? expected.sourceContainer : null,
    presence.containerNames.has(expected.restoreContainer) ? expected.restoreContainer : null,
    presence.volumeNames.has(expected.sourceVolume) ? expected.sourceVolume : null,
    presence.volumeNames.has(expected.restoreVolume) ? expected.restoreVolume : null,
    presence.networkNames.has(expected.network) ? expected.network : null,
  ].filter((value): value is string => value !== null);
  if (collisions.length > 0) {
    throw new Nf04GuardError(`Planned resource already exists: ${collisions.join(', ')}`);
  }
}

export function assertNf04ContainerEvidence(
  manifest: Nf04Manifest,
  role: 'source' | 'restore',
): void {
  assertNf04ManifestBoundary(manifest);
  const expected = deriveNf04ExpectedNames(manifest.runId);
  const container =
    role === 'source' ? manifest.observed.sourceContainer : manifest.observed.restoreContainer;
  const volume =
    role === 'source' ? manifest.observed.sourceVolume : manifest.observed.restoreVolume;
  const network = manifest.observed.network;
  if (!container || !volume || !network) {
    throw new Nf04GuardError(`Observed ${role} Docker evidence is incomplete`);
  }
  if (
    container.imageId !== manifest.image.expectedImageId ||
    container.labels['mh.nf04.run'] !== manifest.runId ||
    container.labels['mh.nf04.role'] !== role ||
    volume.labels['mh.nf04.run'] !== manifest.runId ||
    volume.labels['mh.nf04.role'] !== role ||
    network.labels['mh.nf04.run'] !== manifest.runId ||
    network.labels['mh.nf04.role'] !== 'network' ||
    container.hostPort !==
      (role === 'source' ? manifest.ports.sourceDatabase : manifest.ports.restoreDatabase) ||
    container.networkNames.length !== 1 ||
    container.networkNames[0] !== expected.network
  ) {
    throw new Nf04GuardError(`Observed ${role} Docker identity does not match the manifest`);
  }
  const expectedVolumeName = role === 'source' ? expected.sourceVolume : expected.restoreVolume;
  const dataMount = container.mounts.find(
    (mount) => mount.type === 'volume' && mount.volumeName === expectedVolumeName,
  );
  const artifactMount = container.mounts.find((mount) =>
    ['/nf04-output', '/nf04-input'].includes(mount.destination),
  );
  if (!dataMount || !artifactMount) {
    throw new Nf04GuardError(`Observed ${role} mounts do not match the run topology`);
  }
  const expectedArchiveMountSource = resolve(manifest.archivesRoot ?? manifest.artifactRoot);
  if (
    !dataMount.readWrite ||
    (manifest.archivesRoot && dataMount.destination !== '/var/lib/postgresql') ||
    !matchesNf04DockerBindSource(expectedArchiveMountSource, artifactMount.source)
  ) {
    throw new Nf04GuardError(`Observed ${role} mount access or source path is invalid`);
  }
  if (
    role === 'source' &&
    (!artifactMount.readWrite || artifactMount.destination !== '/nf04-output')
  ) {
    throw new Nf04GuardError('Source artifact mount must be read-write at /nf04-output');
  }
  if (
    role === 'restore' &&
    (artifactMount.readWrite || artifactMount.destination !== '/nf04-input')
  ) {
    throw new Nf04GuardError('Restore artifact mount must be read-only at /nf04-input');
  }
  if (manifest.archivesRoot) {
    assertExecutableSecretMounts(manifest, role, container.mounts);
  }
}

function assertExecutableSecretMounts(
  manifest: Nf04Manifest,
  role: 'source' | 'restore',
  mounts: NonNullable<Nf04Manifest['observed']['sourceContainer']>['mounts'],
): void {
  const pgPass = role === 'source' ? manifest.files.sourcePgPass : manifest.files.restorePgPass;
  const managerPassword =
    role === 'source'
      ? manifest.files.sourceManagerPassword
      : manifest.files.restoreManagerPassword;
  if (!managerPassword) {
    throw new Nf04GuardError(`Observed ${role} manager secret evidence is incomplete`);
  }
  const expected = [
    {
      source: resolve(pgPass),
      destination:
        role === 'source' ? '/run/secrets/nf04-source.pgpass' : '/run/secrets/nf04-restore.pgpass',
    },
    {
      source: resolve(managerPassword),
      destination: '/run/secrets/nf04-manager-password',
    },
  ];
  const secretMounts = mounts.filter(
    (mount) => mount.type === 'bind' && mount.destination.startsWith('/run/secrets/'),
  );
  if (
    secretMounts.length !== expected.length ||
    secretMounts.some(
      (mount) =>
        mount.readWrite ||
        !expected.some(
          (candidate) =>
            candidate.destination === mount.destination &&
            matchesNf04DockerBindSource(candidate.source, mount.source),
        ),
    ) ||
    expected.some(
      (candidate) =>
        secretMounts.filter(
          (mount) =>
            mount.destination === candidate.destination &&
            matchesNf04DockerBindSource(candidate.source, mount.source),
        ).length !== 1,
    )
  ) {
    throw new Nf04GuardError(`Observed ${role} secret mounts do not match the exact run files`);
  }
  const secretsRoot = resolve(manifest.artifactRoot, 'secrets');
  for (const { source } of expected) {
    if (!isPathWithin(secretsRoot, source)) {
      throw new Nf04GuardError(`Observed ${role} secret mount escapes the exact run secrets root`);
    }
  }
  const unexpectedRunBind = mounts.find((mount) => {
    if (mount.type !== 'bind') return false;
    const hostSource = resolveNf04DockerBindSource(mount.source);
    return (
      hostSource !== undefined &&
      isPathWithin(resolve(manifest.artifactRoot), hostSource) &&
      !sameNf04HostPath(hostSource, resolve(manifest.archivesRoot!)) &&
      !expected.some((candidate) => sameNf04HostPath(hostSource, candidate.source))
    );
  });
  if (unexpectedRunBind) {
    throw new Nf04GuardError(`Observed ${role} container exposes an unexpected run-local path`);
  }
  if (resolve(join(manifest.artifactRoot, 'archives')) !== resolve(manifest.archivesRoot!)) {
    throw new Nf04GuardError('Observed archive mount source is not the exact archives directory');
  }
}

export function resolveNf04DockerBindSource(
  observedSource: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== 'win32') {
    return isAbsolute(observedSource) ? resolve(observedSource) : undefined;
  }

  const match = /^\/run\/desktop\/mnt\/host\/([a-z])\/(.+)$/iu.exec(observedSource);
  if (match) {
    const [, drive, relativeSource] = match;
    const segments = relativeSource!.split('/');
    if (
      segments.some(
        (segment) =>
          segment.length === 0 || segment === '.' || segment === '..' || segment.includes('\\'),
      )
    ) {
      return undefined;
    }

    const root = `${drive!.toUpperCase()}:\\`;
    const candidate = win32.resolve(root, ...segments);
    if (
      !isFixedWindowsDrivePath(candidate) ||
      win32.parse(candidate).root.toLowerCase() !== root.toLowerCase()
    ) {
      return undefined;
    }
    const relative = win32.relative(root, candidate);
    const canonicalDockerSource = `${DOCKER_DESKTOP_WINDOWS_MOUNT_PREFIX}${drive!.toLowerCase()}/${relative.replaceAll('\\', '/')}`;
    if (canonicalDockerSource.toLowerCase() !== observedSource.toLowerCase()) return undefined;
    return candidate;
  }

  const parsed = win32.parse(observedSource);
  if (!/^[a-z]:\\$/iu.test(parsed.root) || observedSource.startsWith('\\\\')) return undefined;
  const candidate = win32.resolve(observedSource);
  return isFixedWindowsDrivePath(candidate) ? candidate : undefined;
}

export function matchesNf04DockerBindSource(
  expectedHostPath: string,
  observedSource: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const resolvedObserved = resolveNf04DockerBindSource(observedSource, platform);
  return (
    resolvedObserved !== undefined && sameNf04HostPath(resolvedObserved, expectedHostPath, platform)
  );
}

function sameNf04HostPath(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32') {
    return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
  }
  return resolve(left) === resolve(right);
}

function isFixedWindowsDrivePath(path: string): boolean {
  return /^[a-z]:\\$/iu.test(win32.parse(path).root) && !path.startsWith('\\\\');
}

export async function readNf04DatabaseIdentity(
  pool: Pick<Pool, 'query'>,
): Promise<Nf04DatabaseIdentity> {
  const result = await pool.query<{
    database_name: string;
    database_oid: number;
    system_identifier: string;
    current_user_name: string;
  }>(
    `SELECT current_database() AS database_name,
            (SELECT oid::int FROM pg_database WHERE datname=current_database()) AS database_oid,
            (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
            current_user AS current_user_name`,
  );
  const row = result.rows[0];
  if (!row) throw new Nf04GuardError('Database identity query returned no row');
  return {
    databaseName: row.database_name,
    databaseOid: row.database_oid,
    systemIdentifier: row.system_identifier,
    currentUser: row.current_user_name,
  };
}

export function assertNf04DatabaseIdentity(
  actual: Nf04DatabaseIdentity,
  expected: Readonly<{
    databaseName: string;
    databaseOid?: number;
    systemIdentifier: string;
    roleName?: string;
  }>,
): void {
  if (!actual.databaseName.endsWith('_test') || actual.databaseName !== expected.databaseName) {
    throw new Nf04GuardError('Connected database does not match the exact protected _test target');
  }
  if (actual.systemIdentifier !== expected.systemIdentifier) {
    throw new Nf04GuardError('PostgreSQL system identifier does not match the manifest');
  }
  if (expected.databaseOid !== undefined && actual.databaseOid !== expected.databaseOid) {
    throw new Nf04GuardError('Database OID does not match the manifest');
  }
  if (expected.roleName !== undefined && actual.currentUser !== expected.roleName) {
    throw new Nf04GuardError('Connected role does not match the manifest');
  }
}
