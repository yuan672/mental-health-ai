# Replacement Frontend Design QA

## Reference and scope

- Visual source of truth: the project-owner supplied
  `C:\Users\23757\Desktop\gemini-code-1789133107873.html` prototype (SHA-256
  `27b6001822b339c2aa3c5f52a28e01eac783187e7fc3232eab8086db40135496`).
- Local review capture set:
  `E:\study-project\handoff\frontend-design-reference\`.
- Implemented surfaces: Landing, Login, Registration, authenticated Home, Chat,
  Incognito Chat, Mood, local Diary notebooks, Knowledge list/detail, Profile,
  Privacy, shared App Shell, navigation, drawers, dialogs, and responsive states.
- Existing backend contracts remain authoritative for authentication, registration,
  Consent, Session invalidation, AI safety, persistent/Incognito data boundaries,
  quota, Mood, Knowledge, and deletion behavior.

## Visual comparison

The implementation uses the prototype's warm cream and forest-green palette,
watercolor room scenes, illustrated cat companions, serif display typography,
rounded paper-like cards, compact navigation, two-column desktop compositions, and
single-column mobile flow. The previous frontend's visual system is not retained as
a design constraint.

The prototype motion language is also implemented: eight mood-specific cat
reactions, the breathing/waiting/petting chat companion, the reactive login cat,
paper-pull navigation, animated weather choices, notebook opening/closing and page
turns, plus the cat-led route transition. Reduced-motion preferences bypass the
non-essential movement while retaining every operation.

Reviewed at desktop and narrow widths, including 1280 x 720, 390 x 844, and the
browser regression widths 320, 390, and 1440 pixels. Long content, chat composition,
mobile navigation, Mood controls, Knowledge cards, diary writing/history, dialogs,
and safe-area spacing were included in the review. Visual evidence:

- `E:\study-project\mental-health-ai\docs\reviews\replacement-frontend\route-transition.png`
- `E:\study-project\mental-health-ai\docs\reviews\replacement-frontend\diary-shelf-desktop.png`
- `E:\study-project\mental-health-ai\docs\reviews\replacement-frontend\diary-writing-mobile.png`

## Intentional product-contract deviations from the prototype

- Diary entries follow the supplied prototype's local-only model. They are stored
  in IndexedDB under the authenticated user ID, stay out of the server conversation
  history, and are labelled as saved in this browser. Logging out unmounts and
  clears the visible diary state; a different account reads a different key.
- Login credentials, message bodies, drafts, and other sensitive content are not
  persisted in browser storage.
- Registration never generates fake age-verification evidence or invents Consent
  versions; unavailable server requirements remain fail closed.
- Messages and Knowledge blocks use safe React text rendering rather than arbitrary
  HTML or Markdown.
- Deletion wording does not claim removal of independent Risk Event, Audit, or
  backup data.
- Production safety/readiness internals are not exposed in the user interface.

## Findings and resolution

- P0: none.
- P1: none. During the final browser pass, the extra Diary navigation item exposed
  a short-viewport sidebar collision; the history list now owns a bounded scrolling
  region and no longer sits beneath Delete All. Login focus motion was moved to CSS
  so it cannot race controlled credential fields.
- P2: none. Diary subroutes retain the Diary shell title, fieldsets do not inherit
  unwanted borders, and open-book overlays cannot intercept controls. Route
  replacement from a new Chat to its persistent ID keeps the same transition and
  does not disturb the active stream owner.

final result: passed
