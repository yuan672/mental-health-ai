// Uses the existing guarded fixture publisher; never sets human review evidence.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const api = path.join(root, 'apps/api');
const directory = path.join(root, 'content/knowledge/local-reading-2026-09-14');
const action = process.argv[2] ?? '--validate';
assert(['--validate', '--apply'].includes(action), 'Use --validate or --apply');
process.chdir(api);
require(path.join(api, 'node_modules/reflect-metadata'));
const { syntheticKnowledgeManifestSchema } = require(
  path.join(api, 'dist/src/knowledge/knowledge.schemas'),
);
const index = JSON.parse(fs.readFileSync(path.join(directory, 'index.json'), 'utf8'));
assert.equal(index.scope, 'development-test-only');
assert(Array.isArray(index.files) && index.files.length === 12);
const manifests = index.files.map((name) => {
  assert(/^local-reading-[a-z0-9-]+\.v1\.json$/.test(name));
  const manifest = syntheticKnowledgeManifestSchema.parse(
    JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')),
  );
  assert.equal(name, `${manifest.articleKey}.v${manifest.version}.json`);
  return manifest;
});
assert.equal(new Set(manifests.map((manifest) => manifest.articleKey)).size, manifests.length);

async function main() {
  if (action === '--validate') {
    console.log(JSON.stringify({ event: 'local_reading_validated', articles: manifests.length }));
    return;
  }
  const { env } = require(path.join(api, 'dist/src/config/env'));
  const { KnowledgeFixtureService, assertSyntheticKnowledgeFixtureEnvironment } = require(
    path.join(api, 'dist/src/knowledge/knowledge-fixture.service'),
  );
  assertSyntheticKnowledgeFixtureEnvironment(env.APP_ENV, env.DATABASE_URL);
  const { DatabaseService } = require(path.join(api, 'dist/src/database/database.service'));
  const { KnowledgePublicationRepository } = require(
    path.join(api, 'dist/src/knowledge/knowledge-publication.repository'),
  );
  const database = new DatabaseService();
  try {
    const publisher = new KnowledgeFixtureService(new KnowledgePublicationRepository(database));
    for (const manifest of manifests) {
      const result = await publisher.publishSynthetic(manifest);
      console.log(JSON.stringify({ event: 'local_reading_loaded', ...result }));
    }
  } finally {
    await database.onApplicationShutdown();
  }
}

main().catch(() => {
  // Do not print DB connection strings, editorial bodies, or credentials.
  console.error(JSON.stringify({ event: 'local_reading_failed' }));
  process.exitCode = 1;
});
