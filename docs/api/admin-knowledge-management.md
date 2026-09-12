# Admin Knowledge Management API

- Status: Phase 6 Batch 3 implementation merged in PR #31
- Base path: `/admin/knowledge`
- Authentication: current Staff Session only
- Transport: JSON over HTTPS; `Cache-Control: private, no-store`
- Related: ADR-018, ADR-019, ADR-020, and
  `docs/architecture/phase-6-admin-knowledge-management-design.md`

This contract is accepted for the bounded backend implementation. No Admin page is
included, and acceptance is not content-review or production-policy approval.

## 1. Common rules

- `mh_staff_session` authenticates the request. Ordinary `mh_session` is never
  accepted.
- Every route, including GET, requires an exact trusted Admin Origin. Mutations
  additionally require `mh_staff_csrf` / `x-staff-csrf-token`; GET requests do not
  require a CSRF header.
- Controller guards perform a preliminary session check. The application service
  then opens its short database transaction and calls the database Staff
  authorizer inside it before the protected read/change and Audit append.
  Controllers cannot supply a Staff principal ID.
- All route/query/body and response shapes are strict Zod schemas.
- `articleKey` is 1–100 lowercase ASCII letters/digits separated by single hyphens.
- `version`, `draftRevision`, and `expectedDraftRevision` are positive integers.
- List `limit` defaults to 20 and is bounded to 1–50. Cursors are opaque strings,
  max 1,024 characters, and must be returned unchanged by a client.
- Candidate limits reuse the existing Knowledge contract: title 160 code points,
  summary 320, at most 100 blocks, at most 30,000 total block code points, and at
  most 20 sources. Source fields retain existing bounds and require an absolute
  credential-free HTTPS URL.
- Responses never expose a password, email, session token, CSRF token, ordinary
  user data, arbitrary reviewer notes, or raw Audit data.

Successful responses use the existing envelope:

```json
{
  "success": true,
  "data": {}
}
```

## 2. Shared projections

### Workflow status

```json
{
  "articleId": "7c2c63fc-cd94-45f0-beb6-98d71cf18f92",
  "articleKey": "understanding-everyday-stress",
  "versionId": "8aa20795-462f-401e-8098-33320821101c",
  "version": 2,
  "draftRevision": 7,
  "contentOrigin": "curated",
  "reviewStatus": "source_verified",
  "publicationStatus": "draft",
  "publicationEligible": true,
  "createdAt": "2026-09-12T08:00:00.000Z",
  "reviewedAt": "2026-09-12T09:00:00.000Z",
  "publishedAt": null,
  "withdrawnAt": null
}
```

`publicationEligible` is a server-derived current-state hint, not stored evidence.
Every mutation still rechecks eligibility under lock.

### Candidate input

```json
{
  "title": "认识日常压力",
  "summary": "用于接口测试的合成摘要。",
  "contentBlocks": [
    { "type": "heading", "level": 2, "text": "合成标题" },
    { "type": "paragraph", "text": "这是合成测试正文，不是已审核内容。" },
    {
      "type": "list",
      "style": "unordered",
      "items": ["合成条目一", "合成条目二"]
    },
    { "type": "callout", "tone": "information", "text": "仅供测试。" }
  ],
  "sources": [
    {
      "publisherName": "合成来源发布者",
      "sourceTitle": "合成来源标题",
      "sourceUrl": "https://source.test.invalid/documents/stress-v1",
      "sourcePublishedAt": null,
      "sourceVersionLabel": "synthetic-v1",
      "sourceLocator": "section-1",
      "retrievedAt": "2026-09-12T07:00:00.000Z"
    }
  ]
}
```

The values above are schema examples only. Admin HTTP rejects
`synthetic_fixture`; protected Development/Test fixtures remain the only synthetic
creation path.

## 3. Directory and authoritative status

### `GET /admin/knowledge/articles?limit=20&cursor=...`

Permission: any one of `knowledge:draft_write`, `knowledge:source_review`, or
`knowledge:publish`.

The bounded directory returns workflow metadata only:

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "articleId": "7c2c63fc-cd94-45f0-beb6-98d71cf18f92",
        "articleKey": "understanding-everyday-stress",
        "highestVersion": 2,
        "currentPublishedVersion": 1,
        "editableDraftVersion": null,
        "latestVerifiedCandidateVersion": 2,
        "articleCreatedAt": "2026-09-10T09:00:00.000Z"
      }
    ],
    "nextCursor": null
  }
}
```

Order is the existing stable article identity order
`(articleCreatedAt desc, articleId desc)`. The cursor encodes those values and a
schema discriminator. It is not a cross-request snapshot. A concurrent article
creation can change later pages, while transitions update fields in a returned
item; callers refresh from the first page. No new mutable directory timestamp is
introduced solely for pagination.

### `GET /admin/knowledge/articles/:articleKey/versions/:version/status`

Permission: any one of the three Knowledge permissions.

Returns the authoritative workflow-status projection. It is the general
read-after-unknown-result endpoint and does not return candidate body or sources.

## 4. Editor contract

### Create exact next draft

`POST /admin/knowledge/articles/:articleKey/versions/:version`

Permission: `knowledge:draft_write`.

Body is exactly the Candidate input. It does not accept origin/review/publication
or actor/timestamp fields.

Response:

```json
{
  "success": true,
  "data": {
    "disposition": "applied",
    "state": {
      "articleKey": "understanding-everyday-stress",
      "version": 2,
      "draftRevision": 5,
      "contentOrigin": "curated",
      "reviewStatus": "unverified",
      "publicationStatus": "draft"
    }
  }
}
```

An exact create retry first compares the normalized complete candidate. It may
return `disposition: "no_change"` and current state, including when that exact
candidate has since advanced to reviewed or published; it never reverses later
state. If the existing candidate differs, it returns 409. The response is not an
immutable operation receipt.

### Read editable draft

`GET /admin/knowledge/articles/:articleKey/versions/:version/draft`

Permission: `knowledge:draft_write`.

Returns exact title, summary, content blocks, complete ordered sources, status, and
`draftRevision`. The service returns data only after the read Audit commits.

### Replace entire candidate

`PUT /admin/knowledge/articles/:articleKey/versions/:version/draft`

Permission: `knowledge:draft_write`.

```json
{
  "expectedDraftRevision": 5,
  "candidate": {
    "title": "认识日常压力",
    "summary": "修订后的合成摘要。",
    "contentBlocks": [{ "type": "paragraph", "text": "修订后的合成正文。" }],
    "sources": [
      {
        "publisherName": "合成来源发布者",
        "sourceTitle": "合成来源标题",
        "sourceUrl": "https://source.test.invalid/documents/stress-v2",
        "sourcePublishedAt": null,
        "sourceVersionLabel": "synthetic-v2",
        "sourceLocator": "section-2",
        "retrievedAt": "2026-09-12T10:00:00.000Z"
      }
    ]
  }
}
```

Replacement is all-or-nothing. There is no block, field, reorder, or source-row
mutation endpoint. The service first requires an editable unverified draft and an
exact current `expectedDraftRevision`. A material replacement returns a new opaque
revision; exact same state at the current revision returns `no_change` without
advancing it. A stale revision always returns 409, even if current content happens
to match. A stale retry after review or publication also returns 409 and recovers
through an exact GET; it cannot be treated as an original immutable receipt.

## 5. Source reviewer contract

### Read exact candidate

`GET /admin/knowledge/articles/:articleKey/versions/:version/review-candidate`

Permission: `knowledge:source_review`.

Returns the complete candidate plus exact `draftRevision`, origin, and current
review state in one consistent short database view.

### Verify exact candidate revision

`POST /admin/knowledge/articles/:articleKey/versions/:version/source-review`

Permission: `knowledge:source_review`.

```json
{
  "expectedDraftRevision": 7,
  "confirmation": "source_verified"
}
```

No identity or timestamp is accepted. For an applied review, the server binds the
current Staff principal UUID and clock only after reloading the exact candidate at
revision 7 under the article-then-exact-version lock. Body, revision, ordered
sources, review state, and the required Audit are evaluated in one short
transaction.

```json
{
  "success": true,
  "data": {
    "disposition": "applied",
    "articleKey": "understanding-everyday-stress",
    "version": 2,
    "draftRevision": 7,
    "reviewStatus": "source_verified",
    "reviewedBy": "f3b90b91-ea9a-41c8-a272-983c62cab707",
    "reviewedAt": "2026-09-12T11:00:00.000Z"
  }
}
```

For `disposition=applied`, `reviewedBy` is the current Staff principal UUID, not an
email or a professional credential claim. An already frozen source-verified
version at the exact requested revision returns `no_change` with its original
bounded accountable-reviewer identity and time, including after publication or
withdrawal. Restricted CLI evidence may therefore contain a non-UUID opaque
reviewer identifier. The HTTP caller is recorded as the actor of the new
`no_change` Audit, but never replaces or impersonates the original reviewer.

## 6. Publisher contract

### Read publication projection

`GET /admin/knowledge/articles/:articleKey/versions/:version/publication-state`

Permission: `knowledge:publish`.

Returns workflow status plus original review evidence and bounded ordered source
identity (publisher, title, source date/version/locator, retrieved time). It omits
content blocks and source URLs because publication needs evidence identity, not an
editorial content channel.

### Publish exact version

`POST /admin/knowledge/articles/:articleKey/versions/:version/publish`

Permission: `knowledge:publish`.

```json
{ "expectedDraftRevision": 7 }
```

The service rechecks curated origin, complete source evidence, exact review state,
revision, unresolved predecessors, and current published version under the
article-then-exact-version lock. The restricted CLI applies the same predecessor
check when it creates and publishes a previously absent target; it cannot skip an
unresolved lower HTTP draft. A higher draft does not block publishing the next
eligible predecessor, but it cannot publish before that predecessor is published
or explicitly retired.
Response disposition is `applied` or `no_change`; `no_change` applies only while
the exact target remains current published at that revision. Original `reviewedAt`
and `publishedAt` are never overwritten by a retry. An already withdrawn target
conflicts and cannot reactivate.

### Withdraw or retire exact version

`POST /admin/knowledge/articles/:articleKey/versions/:version/withdraw`

Permission: `knowledge:publish`.

```json
{ "expectedDraftRevision": 7 }
```

The exact published target becomes withdrawn. Only an exact
`curated + draft + source_verified` candidate may be retired without ever being
exposed; it keeps `publishedAt=null`, gains one server-owned `withdrawnAt`, and its
candidate/review evidence remains immutable. An unverified draft returns 409 and
remains editable through the full replacement endpoint. An exact
already-withdrawn target with matching revision returns `no_change` and its
original time. An old withdraw retry never changes a newer published version.

This retirement is how a wrong frozen, already source-verified candidate is skipped
safely. After all lower versions are published/withdrawn or retired, the next
verified successor becomes eligible. An unverified error is corrected atomically
in place; the service never requires falsely verifying or publishing it.

## 7. Error contract

Errors use the existing envelope. Message text is safe and not a stable client
contract.

| HTTP | Code                              | Meaning                                                                                                                     |
| ---- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 400  | `VALIDATION_ERROR`                | path, query, cursor, body, bounds, or strict-union failure                                                                  |
| 401  | `UNAUTHENTICATED`                 | missing, expired, revoked, disabled, or stale Staff Session                                                                 |
| 403  | `FORBIDDEN`                       | valid Staff principal lacks the exact permission                                                                            |
| 403  | `KNOWLEDGE_PUBLICATION_FORBIDDEN` | a disclosed target fails a bounded publication policy that the caller cannot override                                       |
| 404  | `KNOWLEDGE_ARTICLE_NOT_FOUND`     | exact Admin-visible article/version is unavailable                                                                          |
| 409  | `KNOWLEDGE_PUBLICATION_CONFLICT`  | stale revision, changed candidate, unresolved predecessor, invalid transition/order, gap, or withdrawn reactivation attempt |
| 503  | `ADMIN_KNOWLEDGE_RESULT_UNKNOWN`  | commit outcome could not be confirmed; read exact current state                                                             |
| 500  | existing safe storage error       | confirmed internal/storage failure without payload details                                                                  |

A 404 after an uncertain create is only the result of that read. It does not prove
the earlier request rolled back or will never commit. A 409 requires a fresh read
and a new explicit human decision; the client must not auto-apply a different
candidate or revision.

For replacement specifically, a committed revision-5 update may result in
revision 7 if source trigger increments are involved. If its response is lost, the
original revision-5 retry receives 409 even when the payload now matches. The
caller reads the exact draft/status; only a deliberate request using current
revision 7 can receive current-state `no_change` or apply another edit.

Synthetic exact targets receive the same 404 unavailable response for Admin reads
and mutations in every environment. Staging/Production therefore do not reveal
their identity or URLs; Development/Test synthetic setup remains available only
through the protected fixture path.

Admin directory, status, candidate, and publication-state responses are assembled
inside short `REPEATABLE READ` transactions. They remain `READ WRITE` because the
required access Audit must commit in the same transaction before sensitive data is
returned. This is a response-consistency boundary, not a long-lived editorial
snapshot.

## 8. Audit and privacy behavior

Every successful sensitive read, applied mutation, and `no_change` mutation has an
allowlisted Audit row in the same transaction as its data read/change. If Audit
append fails, the response is not returned and mutations roll back.

Audit contains only Staff actor ID, action, resource type/ID, server time,
retention, a non-content state-derived key for an applied mutation (or a fresh
request key for read/`no_change` access), and the action-specific bounded metadata
defined in the design. It contains no article text, title, summary, source URL,
source payload, Staff email, request body, content hash, arbitrary DTO/Error,
prompt, retrieval query, or user content.

No endpoint creates reading analytics, calls a Provider, or writes browser/user
state. Public and Knowledge AI readers retain their existing contracts.
