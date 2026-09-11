# Knowledge Base API

Phase 5E-1 exposes an authenticated, read-only Knowledge Base. PostgreSQL is the
runtime source of truth. The API never publishes drafts, withdrawn versions,
environment-hidden fixtures, reviewer identities, or internal version UUIDs.

All responses use `Cache-Control: private, no-store`. Reading knowledge content is
independent of AI Chat availability, AI quota, and AI-admission Consent; it only
requires a valid session.

## List articles

```http
GET /knowledge/articles?limit=20&cursor=<opaque>
```

- `limit` defaults to 20 and must be between 1 and 50.
- Results are ordered by `publishedAt DESC`, then internal version ID descending.
- `nextCursor` is opaque. Clients must return it unchanged and must not infer its
  contents.
- Pagination is not a cross-request snapshot. A later publication or withdrawal
  can change subsequent pages.

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "articleKey": "synthetic-everyday-stress",
        "title": "合成测试：认识日常压力",
        "summary": "仅用于开发与自动化测试的合成知识内容。",
        "version": 1,
        "contentOrigin": "synthetic_fixture",
        "reviewStatus": "unverified",
        "reviewedAt": null,
        "publishedAt": "2026-09-11T08:00:00.000Z",
        "sourcePublishers": ["合成测试发布者"]
      }
    ],
    "nextCursor": null
  }
}
```

The example is synthetic test data, not a production article or a verified source.
Staging and Production do not return `synthetic_fixture` content.

## Get the current article

```http
GET /knowledge/articles/:articleKey
```

The response describes the one currently published version and adds:

- `contentBlocks`: a bounded union of heading, paragraph, list, and callout blocks;
- `sources`: ordered HTTPS source identities and retrieval metadata.

Content blocks contain plain text only. They contain no HTML, Markdown, executable
component, iframe, media embed, or arbitrary content link. Only validated source
records are links in a future Web renderer.

Missing, draft, withdrawn, and environment-hidden articles share the same response:

```json
{
  "success": false,
  "error": {
    "code": "KNOWLEDGE_ARTICLE_NOT_FOUND",
    "message": "知识内容当前不可用"
  }
}
```

Invalid sessions return `UNAUTHENTICATED`; invalid keys/cursors return
`VALIDATION_ERROR`; storage failures use the existing safe error envelope. Error
responses do not include article bodies, source payloads, SQL details, or release
manifests.

## Mutation boundary

There is no public create, update, publish, or withdraw route. Phase 5E-1 uses the
restricted internal release commands documented in
`docs/architecture/knowledge-publication-runbook.md`. Phase 6 may later provide a
separately authorized management workflow.

No read operation calls an LLM, classifier, embedding provider, Risk Detection, or
AI orchestration service, and no reading-history record is created.
