import 'reflect-metadata';
import { loadKnowledgeManifest } from '../knowledge/knowledge-manifest.loader';

async function run(): Promise<void> {
  const path = process.argv[2];
  if (!path) throw new Error('A manifest path is required');
  const manifest = await loadKnowledgeManifest(path);
  process.stdout.write(
    JSON.stringify({
      event: 'knowledge_manifest_validated',
      articleKey: manifest.articleKey,
      version: manifest.version,
      contentOrigin: manifest.contentOrigin,
      reviewStatus: manifest.reviewStatus,
    }) + '\n',
  );
}

void run().catch(() => {
  process.stderr.write(JSON.stringify({ event: 'knowledge_manifest_validation_failed' }) + '\n');
  process.exitCode = 1;
});
