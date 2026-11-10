# Private diary context for chat

Accepted design: [ADR-026](../architecture/adr/ADR-026-private-diary-chat-memory.md).

## Account settings

All endpoints require the current authenticated session and return private,
no-store responses. Identity is taken from the session, never a client owner ID.

`GET /diary/ai/access`

```json
{ "success": true, "data": { "policy": { "mode": "none", "revision": 0, "notebookIds": [] } } }
```

`PATCH /diary/ai/access` requires the existing Origin / CSRF protection:

```json
{ "mode": "selected", "notebookIds": ["<owned notebook UUID>"], "expectedRevision": 0 }
```

- `none` is the default. No journal text is retrieved or sent.
- `selected` requires 1–50 distinct, owned notebook UUIDs. New notebooks are excluded.
- `all` includes current and future owned notebooks.
- `none` and `all` must supply an empty `notebookIds` array.
- Successful writes increment `revision`; stale writes return 409. Unknown or
  foreign notebook IDs return 404. Deleted notebooks lose their grants by FK cascade.
- Transactional audit records the policy change event only, without diary text,
  book titles or selected book IDs in audit metadata.

The Web bookshelf and persistent chat each expose an explicit-save permission
dialog. It explains which text is sent to the current provider, the seven-day
window, the meaning of future books and the limit of revocation. Conflict or
uncertain save results require re-reading before another write.

## Persistent chat

Existing `POST /ai/chat/stream` persistent input accepts the optional field
`"diaryAccess":"skip"`. Omission follows the saved account policy; this field
can never expand access. Incognito input remains strict and rejects this field.
The Web checkbox applies to the next send; an explicit retry or uncertain-result
reconciliation keeps the original skip choice.

After normal safety routing and quota admission, LOW/MEDIUM persistent chat reads
saved entries from today and the preceding six Shanghai calendar days. At most
50 recent candidates are ranked locally by query overlap and recency. Up to five
excerpts (450 code points each, within a combined 1800-token diary allowance and
the existing overall context budget) are supplied as untrusted JSON user data.
Only saved title/body/date/mood/weather are eligible. Empty-body, draft-only and
photo-only entries are excluded. No embeddings, external index or stored summary
is created. Public Knowledge content remains a separate feature.

Immediately before transport, one repeatable-read snapshot checks policy revision,
ownership, grants, date window and a hash of the exact saved textual context.
Changed or deleted content fails the turn with a resend message before dispatch.
Changes committed after that final check apply to subsequent requests; data that
has already been sent to the provider cannot be recalled. Existing assistant
messages can still mention prior diaries; closing permission does not erase chat
history. Starting a new conversation or deleting history is available separately.

Optional retrieval failure omits diary context. Aborts and execution deadlines
still terminate the request. Incognito and high/crisis/unavailable routes do not
retrieve diary content. Required consent and pre/post safety checks are preserved.

## Reference metadata

`GET /diary/ai/turns/:turnId` is restricted to the owner of the persistent turn.

```json
{
  "success": true,
  "data": {
    "recorded": true,
    "entries": [
      {
        "notebookId": "<UUID>",
        "day": "2026-09-15",
        "revision": 1,
        "title": "这一天的日记",
        "available": true
      }
    ]
  }
}
```

Only notebook/day/revision are stored after confirmed provider dispatch. The
endpoint looks up the current title; changed/deleted entries return an unavailable
tombstone, without recovering prior text. No record returns `recorded:false` and
an empty array; this is not a guarantee that no bytes reached the provider before
a transport failure. Turn/conversation/account deletion cascades reference rows.
The latest Web turn displays “本次提供给 AI 的日记”, meaning supplied background,
not a claim that every entry was used. Links open `/app/diary/:bookId/:day`.

## Manual acceptance

Open `/app/diary`, then “AI 日记读取权限”. Check each mode, cancel/save, reload,
selected-book checkboxes and new-book behavior. In `/app/chat`, check the next-send
skip option and the expandable diary-reference links. Chat after allowing one
book with a saved entry from the last week. Try switching to no access and a new
conversation. UI appearance, wording and animations remain user-owned manual
acceptance; no Computer Use or browser automation is part of verification.
