import { dirname, join, resolve } from 'node:path';
import {
  deriveNf04ExpectedNames,
  NF04_POSTGRES_IMAGE,
  NF04_TOTAL_ARCHIVE_LIMIT_BYTES,
  nf04ManifestSchema,
  type Nf04Manifest,
} from '../src/nf04/nf04-contract';
import {
  assertNf04ContainerEvidence,
  assertNf04DatabaseIdentity,
  assertNf04ManifestBoundary,
  assertNf04PlannedResourcesAbsent,
} from '../src/nf04/nf04-guards';

const RUN_ID = '20260913-143000-a1b2c3d4';

function manifest(state: Nf04Manifest['state'] = 'planned'): Nf04Manifest {
  const repositoryRoot = resolve(process.cwd(), '../..');
  const artifactRoot = join(dirname(repositoryRoot), 'handoff', 'nf04-backup-restore', RUN_ID);
  return nf04ManifestSchema.parse({
    version: 1,
    runId: RUN_ID,
    state,
    repositoryRoot,
    artifactRoot,
    image: { reference: NF04_POSTGRES_IMAGE, expectedImageId: `sha256:${'a'.repeat(64)}` },
    ports: { sourceDatabase: 55431, restoreDatabase: 55432, isolatedApi: 55433 },
    files: {
      fixtureSecrets: join(artifactRoot, 'fixture-secrets.json'),
      sourcePgPass: join(artifactRoot, 'source.pgpass'),
      restorePgPass: join(artifactRoot, 'restore.pgpass'),
      isolatedApiEnvironment: join(artifactRoot, 'isolated-api.env'),
    },
    observed: {},
    archives: {},
  });
}

describe('NF-04 phase-specific guards', () => {
  it('derives exact bounded resource names without inventing a volume object ID', () => {
    expect(deriveNf04ExpectedNames(RUN_ID)).toEqual({
      sourceContainer: `mh-nf04-${RUN_ID}-src`,
      restoreContainer: `mh-nf04-${RUN_ID}-restore`,
      sourceVolume: 'mh_nf04_a1b2c3d4_src_data',
      restoreVolume: 'mh_nf04_a1b2c3d4_restore_data',
      network: 'mh_nf04_a1b2c3d4_network',
      sourceControlDatabase: 'mh_nf04_a1b2c3d4_source_control_test',
      sourceDatabase: 'mh_nf04_a1b2c3d4_src_test',
      restoreControlDatabase: 'mh_nf04_a1b2c3d4_restore_test',
      preRestoreDatabase: 'mh_nf04_a1b2c3d4_pre_restore_test',
      postRestoreDatabase: 'mh_nf04_a1b2c3d4_post_restore_test',
      sourceRole: 'mh_nf04_a1b2c3d4_source_role',
      restoreRole: 'mh_nf04_a1b2c3d4_restore_role',
    });
  });

  it('rejects broad, in-repository, mismatched, or colliding resource plans', () => {
    const valid = manifest();
    expect(() => assertNf04ManifestBoundary(valid)).not.toThrow();
    expect(() =>
      assertNf04ManifestBoundary({ ...valid, artifactRoot: valid.repositoryRoot }),
    ).toThrow(/artifact|repository/i);
    expect(() =>
      assertNf04ManifestBoundary({
        ...valid,
        files: { ...valid.files, fixtureSecrets: join(dirname(valid.artifactRoot), 'foreign') },
      }),
    ).toThrow(/secret path/i);
    expect(() =>
      assertNf04PlannedResourcesAbsent(valid, {
        containerNames: new Set([deriveNf04ExpectedNames(RUN_ID).sourceContainer]),
        volumeNames: new Set(),
        networkNames: new Set(),
      }),
    ).toThrow(/already exists/i);
    expect(() =>
      assertNf04PlannedResourcesAbsent(
        { ...valid, state: 'resources_created' },
        { containerNames: new Set(), volumeNames: new Set(), networkNames: new Set() },
      ),
    ).toThrow(/planned state/i);
  });

  it('revalidates exact Docker IDs, labels, image, mounts, and access modes', () => {
    const base = manifest('resources_created');
    const names = deriveNf04ExpectedNames(RUN_ID);
    const withEvidence: Nf04Manifest = {
      ...base,
      observed: {
        sourceContainer: {
          id: 'source-container-object-id',
          name: names.sourceContainer,
          imageId: base.image.expectedImageId,
          imageReference: NF04_POSTGRES_IMAGE,
          labels: { 'mh.nf04.run': RUN_ID, 'mh.nf04.role': 'source' },
          mounts: [
            {
              type: 'volume',
              source: '/docker/volumes/source',
              destination: '/var/lib/postgresql/18/docker',
              readWrite: true,
              volumeName: names.sourceVolume,
            },
            {
              type: 'bind',
              source: base.artifactRoot,
              destination: '/nf04-output',
              readWrite: true,
            },
          ],
          networkNames: [names.network],
          hostPort: base.ports.sourceDatabase,
        },
        sourceVolume: {
          name: names.sourceVolume,
          driver: 'local',
          mountpoint: resolve(base.artifactRoot, '../docker-volume'),
          labels: { 'mh.nf04.run': RUN_ID, 'mh.nf04.role': 'source' },
        },
        network: {
          id: 'network-object-id',
          name: names.network,
          driver: 'bridge',
          labels: { 'mh.nf04.run': RUN_ID, 'mh.nf04.role': 'network' },
        },
      },
    };
    expect(() => assertNf04ContainerEvidence(withEvidence, 'source')).not.toThrow();
    expect(() =>
      assertNf04ContainerEvidence(
        {
          ...withEvidence,
          observed: {
            ...withEvidence.observed,
            sourceContainer: {
              ...withEvidence.observed.sourceContainer!,
              id: 'same-name-replacement-id',
              labels: { 'mh.nf04.run': 'foreign-run', 'mh.nf04.role': 'source' },
            },
          },
        },
        'source',
      ),
    ).toThrow(/identity/i);
  });

  it('requires exact database name, OID, system identifier, and optional role', () => {
    const actual = {
      databaseName: 'mh_nf04_a1b2c3d4_src_test',
      databaseOid: 16_384,
      systemIdentifier: '7612345678901234567',
      currentUser: 'mh_nf04_a1b2c3d4_source_role',
    };
    expect(() =>
      assertNf04DatabaseIdentity(actual, {
        databaseName: actual.databaseName,
        databaseOid: actual.databaseOid,
        systemIdentifier: actual.systemIdentifier,
        roleName: actual.currentUser,
      }),
    ).not.toThrow();
    expect(() =>
      assertNf04DatabaseIdentity(actual, {
        databaseName: actual.databaseName,
        databaseOid: actual.databaseOid + 1,
        systemIdentifier: actual.systemIdentifier,
      }),
    ).toThrow(/OID/i);
    expect(() =>
      assertNf04DatabaseIdentity(actual, {
        databaseName: actual.databaseName,
        systemIdentifier: '7612345678901234568',
      }),
    ).toThrow(/system identifier/i);
  });

  it('keeps the manifest strict and free of inline credentials', () => {
    expect(() =>
      nf04ManifestSchema.parse({ ...manifest(), databaseUrl: 'postgresql://secret@host/db' }),
    ).toThrow();
    expect(() =>
      nf04ManifestSchema.parse({
        ...manifest(),
        ports: { sourceDatabase: 55431, restoreDatabase: 55431, isolatedApi: 55433 },
      }),
    ).toThrow(/distinct/i);
    const archive = {
      byteSize: NF04_TOTAL_ARCHIVE_LIMIT_BYTES / 2 + 1,
      sha256: 'b'.repeat(64),
      completedAt: '2026-09-13T03:00:00.000Z',
      listedWithPgRestore: true as const,
    };
    expect(() =>
      nf04ManifestSchema.parse({
        ...manifest(),
        archives: {
          preDelete: { ...archive, fileName: 'pre-delete.dump' },
          postDelete: { ...archive, fileName: 'post-delete.dump' },
        },
      }),
    ).toThrow(/total run budget/i);
  });
});
