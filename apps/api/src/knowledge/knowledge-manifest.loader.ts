import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { knowledgeManifestSchema, type KnowledgeManifest } from './knowledge.schemas';

export async function loadKnowledgeManifest(path: string): Promise<KnowledgeManifest> {
  const candidates = isAbsolute(path)
    ? [path]
    : [resolve(process.cwd(), path), resolve(process.cwd(), '../..', path)];
  let contents: string | null = null;
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      contents = await readFile(candidate, 'utf8');
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (contents === null) throw lastError;
  return knowledgeManifestSchema.parse(JSON.parse(contents) as unknown);
}
