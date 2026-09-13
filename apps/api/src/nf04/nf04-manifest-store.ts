import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { nf04ManifestSchema, type Nf04Manifest, type Nf04RunState } from './nf04-contract';
import {
  assertNf04ManifestBoundary,
  assertNf04PathOwnedByRoot,
  readNf04ProtectedFile,
} from './nf04-guards';

export class Nf04ManifestStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = Nf04ManifestStoreError.name;
  }
}

/**
 * The run manifest is the redacted durable checkpoint for the one local drill.
 * Calls through one store are serialized. The persisted document is replaced
 * from a same-directory, exclusive temporary file and is never assembled from
 * command output or a repository environment file.
 */
export class Nf04ManifestStore {
  private serial: Promise<void> = Promise.resolve();

  constructor(
    readonly manifestPath: string,
    private readonly repositoryRoot: string,
  ) {
    if (basename(resolve(manifestPath)) !== 'manifest.json') {
      throw new Nf04ManifestStoreError('NF-04 manifest must use the exact manifest.json name');
    }
  }

  async read(): Promise<Nf04Manifest> {
    let parsed: unknown;
    try {
      const initial = JSON.parse(await this.readProtected());
      parsed = nf04ManifestSchema.parse(initial);
    } catch {
      throw new Nf04ManifestStoreError('NF-04 manifest could not be read safely');
    }
    const manifest = parsed as Nf04Manifest;
    this.assertBound(manifest);
    return manifest;
  }

  async create(manifest: Nf04Manifest): Promise<void> {
    this.assertBound(manifest);
    await this.enqueue(async () => {
      const path = resolve(this.manifestPath);
      const parent = dirname(path);
      if (resolve(manifest.artifactRoot) !== parent || basename(path) !== 'manifest.json') {
        throw new Nf04ManifestStoreError('NF-04 manifest path does not match the exact run root');
      }
      await assertNf04PathOwnedByRoot(manifest.artifactRoot, path, 'absent');
      const handle = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      try {
        await handle.writeFile(serializeManifest(manifest), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
  }

  async update(
    expectedState: Nf04RunState | readonly Nf04RunState[],
    mutate: (current: Nf04Manifest) => Nf04Manifest,
  ): Promise<Nf04Manifest> {
    return this.enqueue(async () => {
      const current = await this.read();
      const allowed = Array.isArray(expectedState) ? expectedState : [expectedState];
      if (!allowed.includes(current.state)) {
        throw new Nf04ManifestStoreError('NF-04 manifest state changed before update');
      }
      const next = nf04ManifestSchema.parse(mutate(current));
      this.assertBound(next);
      if (
        next.runId !== current.runId ||
        next.repositoryRoot !== current.repositoryRoot ||
        next.artifactRoot !== current.artifactRoot ||
        immutableExecutionConfiguration(next) !== immutableExecutionConfiguration(current)
      ) {
        throw new Nf04ManifestStoreError('NF-04 immutable manifest identity changed');
      }
      await this.replace(current, next);
      return next;
    });
  }

  async quarantine(expectedState: Nf04RunState | readonly Nf04RunState[]): Promise<Nf04Manifest> {
    return this.update(expectedState, (current) => ({ ...current, state: 'quarantined' }));
  }

  private async replace(current: Nf04Manifest, next: Nf04Manifest): Promise<void> {
    const path = resolve(this.manifestPath);
    const before = await assertNf04PathOwnedByRoot(current.artifactRoot, path, 'file');
    const temporaryPath = join(dirname(path), `.manifest.${randomUUID()}.partial`);
    await assertNf04PathOwnedByRoot(current.artifactRoot, temporaryPath, 'absent');
    const handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(serializeManifest(next), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      const stable = await assertNf04PathOwnedByRoot(current.artifactRoot, path, 'file');
      if (
        before.targetIdentity?.device !== stable.targetIdentity?.device ||
        before.targetIdentity?.inode !== stable.targetIdentity?.inode ||
        before.parentIdentity.device !== stable.parentIdentity.device ||
        before.parentIdentity.inode !== stable.parentIdentity.inode
      ) {
        throw new Nf04ManifestStoreError('NF-04 manifest identity changed before replacement');
      }
      await rename(temporaryPath, path);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (error instanceof Nf04ManifestStoreError) throw error;
      throw new Nf04ManifestStoreError('NF-04 manifest replacement failed');
    }
  }

  private readProtected(): Promise<string> {
    return readNf04ProtectedFile({
      repositoryRoot: this.repositoryRoot,
      artifactRoot: dirname(resolve(this.manifestPath)),
      candidatePath: this.manifestPath,
    });
  }

  private assertBound(manifest: Nf04Manifest): void {
    assertNf04ManifestBoundary(manifest);
    if (
      resolve(manifest.repositoryRoot) !== resolve(this.repositoryRoot) ||
      resolve(this.manifestPath) !== resolve(manifest.artifactRoot, 'manifest.json')
    ) {
      throw new Nf04ManifestStoreError('NF-04 manifest does not belong to this store');
    }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.serial.then(work, work);
    this.serial = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function serializeManifest(manifest: Nf04Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function immutableExecutionConfiguration(manifest: Nf04Manifest): string {
  return JSON.stringify({
    archivesRoot: manifest.archivesRoot,
    repository: manifest.repository,
    image: manifest.image,
    ports: manifest.ports,
    files: manifest.files,
  });
}
