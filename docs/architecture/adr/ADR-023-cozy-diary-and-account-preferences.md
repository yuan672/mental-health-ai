# ADR-023: Account-owned diaries and personal display preferences

- Status: Accepted
- Date: 2026-09-14
- Authorization: the user approved the diary/bookshelf/photo design and explicitly requested that the missing backend interfaces be completed with the replacement frontend.
- Partially supersedes ADR-017's exclusion of editable display name, avatar and reading preferences only. Existing Mood semantics, identity facts, re-authentication rules and client-storage boundaries remain unchanged.

## Decision

Implement the approved frontend as React routes and reusable components in `apps/web`, using existing authenticated APIs, CSRF protection and session invalidation. No HTML iframe, mock sign-in, fake completion, client-owned identity or browser-persisted psychological content is introduced.

Add account-owned notebooks, per-day diary records, photos and personal display settings. Each diary row has a committed `saved` snapshot and an independent `draft` snapshot. Saving a draft never replaces the committed reader content until an explicit publish. Creation and updates serialize on the owned notebook row. Each entry mutation requires its current revision; an unknown result is resolved with a GET and an explicit user decision, never an automatic mutation retry.

Notebook names are bounded to 24 Unicode code points. Diary titles are at most 80 code points, body text 10,000, with eight cat moods and nine weather choices. A published page requires mood, weather and either text or a photo. Calendar dates describe diary days, can be in the past, and cannot be in the future in Asia/Shanghai. These semantics belong to Diary; Mood continues its separate five-point check-in contract.

Photos are authenticated multipart uploads, at most 10 MiB each, six referenced per snapshot. PNG/JPEG/WebP/GIF signatures are checked, active formats such as SVG are rejected, and content is served with a verified MIME type, no-store and nosniff. A client-generated photo ID resolves duplicate uploads. The bounded first implementation stores photo bytes as base64 in PostgreSQL, outside ordinary logs; no public static-upload directory is exposed. Unreferenced photos can be removed, and notebook/account deletion cascades all related rows. A notebook day is limited to twelve uploaded photos to accommodate distinct saved and draft snapshots.

Display name, one chosen cat and reading size are separate from identity. Updating them cannot change email, password or age verification. Article bookmarks store only bounded article identifiers; the existing knowledge reader still controls publication visibility. Settings have optimistic revisions. Diary content and settings are owner scoped and are cleared from application memory when the protected application unmounts.

Notebook and diary deletion commit a content-free deletion audit with the deletion transaction. No diary text, photo, name, title or mood is sent to AI, risk analysis, application logs or browser storage. The existing account-deletion transaction removes User and the new rows through foreign-key cascades. Ordinary conversation retention, Incognito, Consent, production AI safety locks and knowledge publication remain unchanged.

## Validation

Review the generated Drizzle migration and apply it to a newly created dedicated test database. Verify isolation between accounts, revision conflicts, saved/draft independence, upload validation, authenticated photo access, deletion cascades, frontend API errors, routing and production build. Synthetic tests are engineering evidence only.
