// Offline, read-only comparison. No environment loading, DB, publication or LLM.
import fs from 'node:fs';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'apps/api/package.json'));
const ts = require('typescript');
const compile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      experimentalDecorators: true,
    },
  }).outputText;
// This hook lives only in this explicitly invoked offline process.
require.extensions['.ts'] = (module, filename) =>
  module._compile(compile(fs.readFileSync(filename, 'utf8')), filename);
const hash = (value) => createHash('sha256').update(value).digest('hex');

export function loadPolicy(revision, transform = (source) => source) {
  const relative = 'apps/api/src/knowledge/knowledge-retrieval.policy.ts';
  const filename = path.join(root, relative);
  const source = revision
    ? execFileSync('git', ['show', `${revision}:${relative}`], { cwd: root, encoding: 'utf8' })
    : fs.readFileSync(filename, 'utf8');
  const module = new Module(filename);
  module.filename = filename;
  module.paths = Module._nodeModulePaths(path.dirname(filename));
  module._compile(compile(transform(source)), filename);
  return new module.exports.KnowledgeRetrievalPolicy();
}

export function loadCorpus(directory) {
  const { syntheticKnowledgeManifestSchema } = require(
    path.join(root, 'apps/api/src/knowledge/knowledge.schemas.ts'),
  );
  const files = fs
    .readdirSync(directory)
    .filter((file) => file.endsWith('.v1.json'))
    .sort();
  if (files.length === 0 || files.length > 50)
    throw new Error('Expected 1–50 local synthetic manifests');
  const hashes = [];
  const candidates = files.map((file, index) => {
    const raw = fs.readFileSync(path.join(directory, file));
    if (raw.length > 256_000) throw new Error('Manifest too large');
    const manifest = syntheticKnowledgeManifestSchema.parse(JSON.parse(raw.toString('utf8')));
    hashes.push({ file, sha256: hash(raw) });
    // In-memory candidate projection only; no database publication is performed.
    return {
      ...manifest,
      versionId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      publicationStatus: 'published',
      publishedAt: '2026-09-18T00:00:00Z',
      sources: manifest.sources.map((source, i) => ({ ...source, ordinal: i + 1 })),
    };
  });
  return { candidates, hashes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, output] = process.argv.slice(2);
  if (!directory || !output)
    throw new Error(
      'Usage: node scripts/knowledge/evaluate-retrieval.mjs <synthetic-corpus-directory> <report.json>',
    );
  const { candidates, hashes } = loadCorpus(directory);
  const queryPath = path.join(root, 'apps/api/test/fixtures/knowledge-reading-queries.json');
  const queries = JSON.parse(fs.readFileSync(queryPath, 'utf8'));
  const variants = {
    original: loadPolicy('6848779674a9421576839bac8210d612fa4d0330'),
    sections_v2: loadPolicy('78fa96f30c56a757089363e9d77a0288388cec9d'),
    current_400_overlap60: loadPolicy(),
    child512_overlap60: loadPolicy(undefined, (source) =>
      source.replace(
        'buildKnowledgeRetrievalChunks(candidate.contentBlocks)',
        'buildKnowledgeRetrievalChunks(candidate.contentBlocks, 512, 60)',
      ),
    ),
    child400_overlap0: loadPolicy(undefined, (source) =>
      source.replace(
        'buildKnowledgeRetrievalChunks(candidate.contentBlocks)',
        'buildKnowledgeRetrievalChunks(candidate.contentBlocks, 400, 0)',
      ),
    ),
    section_parent_only: loadPolicy(undefined, (source) =>
      source.replace('wholeArticleCost <= articleRemaining', 'false'),
    ),
  };
  const results = queries.map((testCase) => ({
    ...testCase,
    variants: Object.fromEntries(
      Object.entries(variants).map(([name, policy]) => {
        const started = performance.now();
        const selected = policy.select(testCase.query, candidates, 1000);
        const latencyMs = performance.now() - started;
        const match = selected.find(
          (bundle) => bundle.articleKey === `local-reading-${testCase.article}`,
        );
        const ordinals = match?.blocks.map((block) => block.ordinal) ?? [];
        return [
          name,
          {
            keys: selected.map((bundle) => bundle.articleKey),
            ordinals,
            hit: testCase.article ? !!match : selected.length === 0,
            complete: testCase.article
              ? testCase.required.every((ordinal) => ordinals.includes(ordinal))
              : selected.length === 0,
            estimatedTokens: selected.reduce((sum, bundle) => sum + bundle.estimatedTokens, 0),
            latencyMs,
          },
        ];
      }),
    ),
  }));
  const summary = Object.fromEntries(
    Object.keys(variants).map((name) => [
      name,
      {
        positiveHits: results.filter((row) => row.article && row.variants[name].hit).length,
        completePositiveContexts: results.filter(
          (row) => row.article && row.variants[name].complete,
        ).length,
        correctNegatives: results.filter((row) => !row.article && row.variants[name].hit).length,
        medianLatencyMs: results.map((row) => row.variants[name].latencyMs).sort((a, b) => a - b)[
          Math.floor(results.length / 2)
        ],
      },
    ]),
  );
  fs.writeFileSync(
    output,
    JSON.stringify(
      {
        note: 'Authored local queries, not user logs; retrieval evidence, not clinical or answer accuracy.',
        hashes,
        querySha256: hash(fs.readFileSync(queryPath)),
        node: process.version,
        icu: process.versions.icu,
        positiveCount: queries.filter((q) => q.article).length,
        negativeCount: queries.filter((q) => !q.article).length,
        summary,
        results,
      },
      null,
      2,
    ),
  );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
