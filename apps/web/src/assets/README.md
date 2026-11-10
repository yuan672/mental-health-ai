# Cozy artwork

These are the user's previously commissioned and selected watercolor assets, copied from
`E:/study-project/handoff/mental-health-frontend-design`. No new image generation or pose redesign
was performed during the React implementation.

- `cozy/cat-brand.png`, `cat-diary-corner.png`, `cat-living-room.png`: approved site illustration set.
- `cozy/cat-emotions-reference.png`: the user-provided eight-cat mood sheet, rendered with SVG viewBox crops; the original pixels are retained.
- `cozy/login-room.png`, `login-cat-watercolor-rest.png`, `login-cat-watercolor-neck-v2.png`, `login-cat-watercolor-parts-closed-v1.png`: current approved watercolor room and continuous login-cat renderer textures.
- `cozy/window-nook.png`, `companion-cat-alpha.png`: existing chat companion artwork.
- `cozy/weather/`: existing weather icon SVGs; attribution and MIT terms are included in `LICENSE.txt` and source information in `manifest.json`.

The login engine is isolated in `features/login-cat/*.mjs`, with explicit TypeScript declarations at
the React boundary. It uses continuous spring motion and the existing articulated watercolor mesh,
and disposes animation frames and GPU resources on unmount. Production assets are emitted by Vite
with hashed filenames; there are no references to the old standalone HTML, absolute local file URLs,
or temporary clipboard files.
