# Diary and personal settings

Implementation decision: [ADR-023](../architecture/adr/ADR-023-cozy-diary-and-account-preferences.md).

All endpoints below require the ordinary authenticated session. Every mutation checks Origin and
the `mh_csrf` / `x-csrf-token` pair. Foreign notebook/photo IDs return 404. Responses and photo streams
use `Cache-Control: private, no-store`; photos additionally use `X-Content-Type-Options: nosniff`.
JSON responses follow `{ success: true, data: ... }` and the existing structured error envelope.

| Endpoint                                        | Result / input                                                                                                                                       |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /diary/notebooks`                          | `{books}` for the current account, maximum 50                                                                                                        |
| `POST /diary/notebooks`                         | `{id, name, cat}`; caller UUID makes a repeated create idempotent                                                                                    |
| `PATCH /diary/notebooks/:id`                    | `{name, cat, expectedRevision}`; `{book}`                                                                                                            |
| `GET /diary/notebooks/:id?before=YYYY-MM-DD`    | `{book, entries, nextBefore}`; 30 entries, newest first, no entry bodies                                                                             |
| `GET /diary/notebooks/:id/entries/:day`         | `{page}` including separate saved/draft snapshots and uploaded-photo metadata; missing day is revision 0                                             |
| `POST /diary/notebooks/:id/entries/:day`        | `{expectedRevision, content, publish}`; `{page}`; a stale revision returns 409                                                                       |
| `DELETE /diary/notebooks/:id/entries/:day`      | `{expectedRevision}`; removes that day's saved page, draft and photos                                                                                |
| `DELETE /diary/notebooks/:id`                   | `{expectedRevision}`; removes the book and all its pages/photos                                                                                      |
| `POST /diary/notebooks/:id/entries/:day/photos` | Multipart fields `photoId` (UUID) and `image` (File); `{photo}`                                                                                      |
| `GET /diary/notebooks/:id/photos/:photoId`      | Authenticated image stream, never a public upload URL                                                                                                |
| `DELETE /diary/notebooks/:id/photos/:photoId`   | Deletes an unreferenced image; 409 while saved/draft content still references it                                                                     |
| `GET /profile/settings`                         | `{settings}`; defaults have revision 0                                                                                                               |
| `PATCH /profile/settings`                       | `{displayName, cat, readingSize, bookmarks, expectedRevision}`; `{settings}`                                                                         |
| `POST /profile/settings`                        | Multipart `settings` (JSON settings write) and `image` (File); atomically saves profile text and a custom avatar, returns `{settings}` with HTTP 200 |
| `GET /profile/settings/avatar/:avatarId`        | Current account's normalized WebP avatar; authenticated, private/no-store/nosniff; other-account or replaced IDs return 404                          |

ADR-025 adds `biography` (plain text, at most 200 Unicode code points) and `avatarId`
(UUID or null) to settings responses. The JSON write accepts both as optional fields;
omitting them preserves existing values for older clients. `avatarId: null` switches
to the chosen cat and removes uploaded bytes. A non-null ID can only retain the
current owned avatar. Multipart saves generate a fresh avatar ID after decoding
the image, and use the same optimistic revision and transaction as all other edits.

Avatars support JPEG, PNG and WebP up to 5 MiB and 16 million input pixels. The server
auto-orients, scales within 512 pixels and re-encodes to WebP without metadata.
Only normalized bytes are stored; profile JSON and operational logs exclude them.
Invalid image/body returns 400, oversized upload 413, stale revision 409. These
failures do not change any profile field. No arbitrary external avatar URL is accepted.

`content` contains `title`, `body`, nullable `mood`/`weather`, and `photoIds`. Saving a draft preserves
the published snapshot. Publishing requires both selections and either text or a photo, replaces
the saved snapshot, and clears the draft. Up to 6 photos may be selected in either snapshot.
Dates follow Asia/Shanghai; genuine past dates are accepted, future dates are rejected.

Notebook names/nicknames: 24 Unicode code points. Titles: 80. Body: 10,000. Reading sizes: 16/18/20.
Bookmarks: at most 100 article keys. Cat moods and weather values are specified in `packages/types/src/diary.ts`.

Photos are validated by file signature (JPEG, PNG, WebP, GIF), limited to 10 MiB each and 12 uploaded
files per notebook/day. UUID-based retries do not upload a duplicate. Files are currently held as
base64 in PostgreSQL, so they follow the same transaction, ownership and backup boundary as diaries;
large-scale storage/object-store migration remains a separate infrastructure decision. Unused uploads
can be explicitly attached or deleted from the editor. There is no automatic transmission to an LLM.

The frontend keeps pending edits in React memory only. A network/409 save failure retains the typed
content and requires reading the authoritative page before another save. No automatic mutation
retry occurs. Account deletion cascades notebooks, pages, photos and settings through migration 0011.
Deletion emits a content-free diary audit event; existing backup and audit retention policy still applies.

# 2026-09-15 extension

Diary context for AI is now a separately authorized, default-off capability under
[ADR-026](../architecture/adr/ADR-026-private-diary-chat-memory.md). See
[private diary memory](private-diary-memory.md) for none / selected / all access,
chat skip behavior, saved-text limits, reference metadata and revocation semantics.
The diary/settings endpoints below do not themselves grant AI access.
