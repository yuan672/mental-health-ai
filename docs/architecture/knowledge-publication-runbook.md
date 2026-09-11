# Knowledge Publication Runbook

This runbook describes the restricted Phase 5E-1 command boundary accepted in
ADR-018. It is not an Admin API, CMS, production-content approval, or substitute
for source/reuse/human review.

## Release artifacts

A release manifest is version-controlled JSON validated by the strict schema in
`apps/api/src/knowledge/knowledge.schemas.ts`. It binds:

- exact lowercase `articleKey` and positive sequential `version`;
- plain-text title, summary, and bounded structured content blocks;
- exact ordered HTTPS source records; and
- content origin and exact review evidence.

The normal curated path accepts only `contentOrigin=curated` with
`reviewStatus=source_verified`, a real accountable `reviewedBy`, an actual
`reviewedAt`, and at least one verified source. Phase 5E-1 cannot assign
`professional_reviewed`. No curated production article is included in this
delivery.

Validate a manifest without writing the database:

```bash
pnpm --filter @mental-health/api knowledge:validate-manifest -- path/to/manifest.json
```

## Curated publication

```bash
pnpm --filter @mental-health/api knowledge:publish -- path/to/manifest.json
```

The command names the exact key/version from the manifest. It never means “latest”.
Version 1 starts an article; later versions must advance one at a time. Publishing
the next version atomically withdraws the current version. An exact retry of the
currently published manifest is a no-op and preserves review/publication evidence.

The command rejects:

- missing/invalid source or review evidence;
- synthetic or `professional_reviewed` manifests;
- a version gap or out-of-order version;
- reuse of a version with changed body, sources, origin, or review evidence; and
- republishing a withdrawn/superseded version.

If commit acknowledgement is uncertain, inspect the exact article/version state
and rerun the exact same manifest. Do not edit rows manually, allocate a replacement
version merely to hide uncertainty, or mutate an old manifest.

## Exact withdrawal

```bash
pnpm --filter @mental-health/api knowledge:withdraw -- article-key 2
```

The command affects only that exact version. A retry preserves the original
`withdrawnAt`. Withdrawing an older version after a newer version is published does
not affect the newer version. Draft and missing targets are rejected. Withdrawal
hides future reads but does not rewrite or delete the body/source evidence.

## Development/Test fixtures

The committed fixture
`apps/api/test/fixtures/knowledge/synthetic-everyday-stress-v1.json` is visibly
synthetic, `unverified`, and contains no reviewer identity/time. It uses no real
source or model.

```bash
pnpm --filter @mental-health/api knowledge:seed-fixture -- \
  apps/api/test/fixtures/knowledge/synthetic-everyday-stress-v1.json
```

This separate command fails closed outside Development/Test. Under `APP_ENV=test`,
the configured PostgreSQL database name must end in `_test`. It does not reset a
schema and does not weaken or call the curated publisher. Staging/Production read
and publication policy rejects synthetic origin; no boolean switch promotes it.

CI performs no external source check and sends no content to an LLM. A successful
fixture test is not source verification, professional review, real-model
evaluation, or production content approval.

## Operational boundaries

- Command output contains fixed events plus article key/version/status only; it
  does not log the manifest, body, or source payload.
- Runtime readers use only current environment-visible published rows and respond
  with `private, no-store`.
- Database migrations contain schema, constraints, and immutable-evidence guards,
  never editorial article bodies.
- Content correction creates a new version; normal update/withdrawal does not
  hard-delete editorial history.
- Real publication still requires the content, source, reuse-rights, and human
  review prerequisites listed in the accepted Phase 5E design.
