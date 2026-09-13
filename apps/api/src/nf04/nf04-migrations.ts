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
        })
        .passthrough(),
    ),
  })
  .passthrough();

export async function readNf04MigrationHashes(migrationsRoot: string): Promise<readonly string[]> {
  const journal = journalSchema.parse(
    JSON.parse(await readFile(join(migrationsRoot, 'meta', '_journal.json'), 'utf8')),
  );
  const hashes: string[] = [];
  for (const entry of journal.entries) {
    const migrationSql = await readFile(join(migrationsRoot, `${entry.tag}.sql`), 'utf8');
    hashes.push(createHash('sha256').update(migrationSql).digest('hex'));
  }
  return hashes;
}
