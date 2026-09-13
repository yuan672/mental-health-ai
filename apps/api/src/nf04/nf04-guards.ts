import { basename, dirname, resolve } from 'node:path';
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
  for (const secretPath of Object.values(manifest.files)) {
    if (!isPathWithin(canonicalArtifactRoot, secretPath)) {
      throw new Nf04GuardError('Every secret path must remain inside the exact run artifact root');
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
  if (!dataMount.readWrite || resolve(artifactMount.source) !== resolve(manifest.artifactRoot)) {
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
}

export async function readNf04DatabaseIdentity(pool: Pool): Promise<Nf04DatabaseIdentity> {
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
