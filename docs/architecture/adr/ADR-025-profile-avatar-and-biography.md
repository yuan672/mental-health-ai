# ADR-025: Custom profile avatars and biography

- Status: Accepted
- Date: 2026-09-14
- Authorization: the user requested website cat avatars, custom name/avatar, and a personal biography in account settings.
- Extends ADR-023 personal display preferences. Identity and authentication fields remain separate.

## Decision and implementation review

Keep the existing 24-code-point display name and eight cats. Add an optional 200-code-point plain-text biography and one custom avatar per account. Choosing a cat removes the custom avatar on explicit save. The selected cat remains the fallback and companion artwork.

Save all visible edits atomically with the settings revision. JSON PATCH continues to work; multipart POST accepts a JSON settings field and one image. Failed or uncertain writes retain the local form and require a read before another write. Omitted new fields preserve existing values for older clients. A supplied avatar ID can only retain the current account's image; it cannot reference another account or an arbitrary URL.

Accept JPEG, PNG, or WebP up to 5 MiB, decode with a 16-million-pixel bound, auto-orient, resize within 512 pixels and re-encode as WebP without metadata. Invalid images and active formats are rejected. Store only the normalized image in the account-owned settings row, replacing old bytes on save and cascading on account deletion. Serve it only through an authenticated owner endpoint with no-store and nosniff. Settings JSON excludes image bytes. No profile text or image is sent to AI or browser storage.

The design uses the existing cream/sage palette, an avatar preview and upload control, the existing cat grid, name and biography fields, and one save action. The site header reflects saved identity preferences. User acceptance of visual design remains manual; Computer Use is prohibited.

Review the additive generated Drizzle migration; validate it in an empty dedicated test database before applying locally. Verify backward compatibility, atomic conflicts, image decoding/access/isolation/replacement, biography limits, save persistence and frontend error recovery with synthetic data.
