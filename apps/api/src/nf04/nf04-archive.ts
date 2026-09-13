import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, link, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { NF04_TOTAL_ARCHIVE_LIMIT_BYTES } from './nf04-contract';
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

export class Nf04ArchiveManager {
  constructor(
    private readonly runner: Nf04ProcessRunner,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: {
    kind: Nf04ArchiveKind;
    artifactRoot: string;
    sourceContainerId: string;
    sourceRole: string;
    sourceDatabase: string;
    pgPassContainerPath: string;
    timeoutMs: number;
    priorArchive?: Nf04ArchiveEvidence;
    signal?: AbortSignal;
  }): Promise<Nf04ArchiveEvidence> {
    const finalName = `${input.kind}.dump` as const;
    const partialName = `.${finalName}.partial`;
    const partialPath = join(input.artifactRoot, partialName);
    const finalPath = join(input.artifactRoot, finalName);
    const priorArchiveBytes = await this.verifyPriorArchive(input);
    await assertAbsent(partialPath);
    await assertAbsent(finalPath);

    const dump = await this.runner.run({
      executable: 'docker',
      args: [
        'exec',
        '-e',
        `PGPASSFILE=${input.pgPassContainerPath}`,
        input.sourceContainerId,
        'pg_dump',
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
      timeoutMs: input.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (dump.timedOut || dump.exitCode !== 0) {
      throw new Nf04ArchiveError('pg_dump did not complete successfully');
    }

    const partial = await stat(partialPath);
    if (
      !partial.isFile() ||
      partial.size <= 0 ||
      priorArchiveBytes + partial.size > NF04_TOTAL_ARCHIVE_LIMIT_BYTES
    ) {
      throw new Nf04ArchiveError('Partial archive violates the bounded file contract');
    }
    const listing = await this.runner.run({
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
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (listing.timedOut || listing.exitCode !== 0) {
      throw new Nf04ArchiveError('Partial archive table of contents is unreadable');
    }

    // A hard-link creation in the same directory gives no-clobber publication. The
    // partial is removed only after the final name exists.
    await link(partialPath, finalPath);
    await unlink(partialPath);
    const final = await stat(finalPath);
    return {
      fileName: finalName,
      byteSize: final.size,
      sha256: await sha256File(finalPath),
      completedAt: this.now().toISOString(),
      listedWithPgRestore: true,
    };
  }

  async verify(
    artifactRoot: string,
    evidence: Pick<Nf04ArchiveEvidence, 'fileName' | 'byteSize' | 'sha256'>,
  ): Promise<void> {
    if (basename(evidence.fileName) !== evidence.fileName) {
      throw new Nf04ArchiveError('Archive evidence contains a non-canonical file name');
    }
    const archivePath = join(artifactRoot, evidence.fileName);
    const actual = await stat(archivePath);
    if (!actual.isFile() || actual.size !== evidence.byteSize) {
      throw new Nf04ArchiveError('Archive size does not match fixed evidence');
    }
    if ((await sha256File(archivePath)) !== evidence.sha256) {
      throw new Nf04ArchiveError('Archive digest does not match fixed evidence');
    }
  }

  private async verifyPriorArchive(input: {
    kind: Nf04ArchiveKind;
    artifactRoot: string;
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
    await this.verify(input.artifactRoot, input.priorArchive);
    return input.priorArchive.byteSize;
  }
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    return;
  }
  throw new Nf04ArchiveError('Archive path already exists');
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const digest = createHash('sha256');
    const input = createReadStream(path);
    input.on('data', (chunk) => digest.update(chunk));
    input.once('error', reject);
    input.once('end', () => resolve(digest.digest('hex')));
  });
}
