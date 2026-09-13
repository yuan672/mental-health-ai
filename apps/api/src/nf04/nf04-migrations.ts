import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const journalSchema = z
  .object({
    entries: z.array(
      z
        .object({
          idx: z.number().int().nonnegative(),
          tag: z.string().regex(/^\d{4}_[a-z0-9_]+$/),
          when: z.number().int().nonnegative(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export async function readNf04MigrationHashes(migrationsRoot: string): Promise<readonly string[]> {
  return (await readNf04MigrationEvidence(migrationsRoot)).map((entry) => entry.hash);
}

export type Nf04MigrationEvidence = Readonly<{ hash: string; createdAt: number }>;

export async function readNf04MigrationEvidence(
  migrationsRoot: string,
): Promise<readonly Nf04MigrationEvidence[]> {
  const journal = journalSchema.parse(
    JSON.parse(await readFile(join(migrationsRoot, 'meta', '_journal.json'), 'utf8')),
  );
  const evidence: Nf04MigrationEvidence[] = [];
  for (const [position, entry] of journal.entries.entries()) {
    if (entry.idx !== position) throw new Error('NF-04 migration journal order is invalid');
    const migrationSql = await readFile(join(migrationsRoot, `${entry.tag}.sql`), 'utf8');
    evidence.push({
      hash: createHash('sha256').update(migrationSql).digest('hex'),
      createdAt: entry.when,
    });
  }
  return evidence;
}
