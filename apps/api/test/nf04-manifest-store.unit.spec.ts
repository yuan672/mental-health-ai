import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  deriveNf04ExpectedNames,
  NF04_POSTGRES_IMAGE,
  nf04ManifestSchema,
  type Nf04Manifest,
} from '../src/nf04/nf04-contract';
import { Nf04ManifestStore } from '../src/nf04/nf04-manifest-store';

const repositoryRoot = resolve(process.cwd(), '../..');
const createdRoots: string[] = [];

afterEach(async () => {
  for (const root of createdRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('NF-04 manifest store', () => {
  it('creates, reads and atomically advances the exact redacted manifest', async () => {
    const fixture = await createManifest();
    await fixture.store.create(fixture.manifest);
    await expect(fixture.store.read()).resolves.toEqual(fixture.manifest);

    const advanced = await fixture.store.update('planned', (current) => ({
      ...current,
      state: 'resources_created',
    }));

    expect(advanced.state).toBe('resources_created');
    await expect(fixture.store.read()).resolves.toEqual(advanced);
  });

  it('serializes concurrent transitions and rejects a stale expected state', async () => {
    const fixture = await createManifest();
    await fixture.store.create(fixture.manifest);

    const results = await Promise.allSettled([
      fixture.store.update('planned', (current) => ({ ...current, state: 'resources_created' })),
      fixture.store.update('planned', (current) => ({ ...current, state: 'resources_created' })),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await fixture.store.read()).state).toBe('resources_created');
  });

  it('records quarantine without accepting a different run identity', async () => {
    const fixture = await createManifest();
    await fixture.store.create(fixture.manifest);
    await expect(fixture.store.quarantine('planned')).resolves.toMatchObject({
      runId: fixture.manifest.runId,
      state: 'quarantined',
    });
    await expect(
      fixture.store.update('quarantined', (current) => ({
        ...current,
        runId: '20260913-143000-ffffffff',
      })),
    ).rejects.toThrow();
  });

  it('does not allow action code to retarget immutable ports, paths or repository evidence', async () => {
    const fixture = await createManifest();
    await fixture.store.create(fixture.manifest);

    await expect(
      fixture.store.update('planned', (current) => ({
        ...current,
        ports: { ...current.ports, sourceDatabase: 55434 },
      })),
    ).rejects.toThrow('immutable manifest identity changed');
    await expect(fixture.store.read()).resolves.toEqual(fixture.manifest);
  });
});

async function createManifest(): Promise<{
  manifest: Nf04Manifest;
  store: Nf04ManifestStore;
}> {
  const token = Math.random().toString(16).slice(2, 10).padEnd(8, '0');
  const runId = `20260913-143000-${token}`;
  const artifactRoot = join(dirname(repositoryRoot), 'handoff', 'nf04-backup-restore', runId);
  createdRoots.push(artifactRoot);
  const archivesRoot = join(artifactRoot, 'archives');
  const secretsRoot = join(artifactRoot, 'secrets');
  await mkdir(archivesRoot, { recursive: true });
  await mkdir(secretsRoot, { recursive: true });
  const names = deriveNf04ExpectedNames(runId);
  expect(names.sourceDatabase.endsWith('_test')).toBe(true);
  const manifest = nf04ManifestSchema.parse({
    version: 1,
    runId,
    state: 'planned',
    repositoryRoot,
    artifactRoot,
    archivesRoot,
    repository: {
      commitSha: 'a'.repeat(40),
      migrationHashes: ['b'.repeat(64)],
      migrationCreatedAt: [1],
    },
    image: { reference: NF04_POSTGRES_IMAGE, expectedImageId: `sha256:${'a'.repeat(64)}` },
    ports: { sourceDatabase: 55431, restoreDatabase: 55432, isolatedApi: 55433 },
    files: {
      fixtureSecrets: join(secretsRoot, 'fixture-secrets.json'),
      sourcePgPass: join(secretsRoot, 'source.pgpass'),
      restorePgPass: join(secretsRoot, 'restore.pgpass'),
      sourceManagerPassword: join(secretsRoot, 'source-manager-password'),
      restoreManagerPassword: join(secretsRoot, 'restore-manager-password'),
      executionSecrets: join(secretsRoot, 'execution-secrets.json'),
      isolatedApiEnvironment: join(secretsRoot, 'isolated-api.env'),
    },
    observed: {},
    archives: {},
  });
  return {
    manifest,
    store: new Nf04ManifestStore(join(artifactRoot, 'manifest.json'), repositoryRoot),
  };
}
