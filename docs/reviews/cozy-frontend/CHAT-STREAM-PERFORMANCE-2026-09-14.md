# Chat streaming performance — 2026-09-14

Scope: ordinary persistent and incognito chat. This change only addresses reply
batching and presentation; other ongoing frontend and diary work is outside this
change. Visual acceptance remains manual; no browser automation was used.

## Implementation

- Preserve the first sentence's immediate eligibility for output review. Combine
  later short sentences and newlines toward 96 Unicode code points at sentence
  boundaries. Keep the configured 200-character cap and 500 ms flush deadline.
- Enforce the cap even when a single provider delta contains a very long sentence
  with punctuation beyond the cap.
- Every candidate still passes the existing output review before SSE delivery.
  Reviews remain ordered and include the previously approved prefix. High-risk
  full buffering, input assessment, cancellation and consent gates are unchanged.
- Reveal already approved text using elapsed-time animation frames, respecting
  grapheme boundaries and reduced-motion preferences. Catch up when the tab
  resumes or the backlog grows. Do not replay completed history or rewind on
  preference changes.
- Continue the display tail when a transient reply becomes a saved message;
  finish that tail within 160 ms of normal completion. Stop animation on cancel,
  error or safety fallback. Persistence and protocol state retain the full text.
- Change the initial waiting label to “正在准备回复…” because the wait includes
  server processing, not only connection establishment.

## Automated verification

- 59 API foundation and safety unit tests passed.
- 84 batching, foundation integration and safety integration tests passed using
  an isolated `chat_smooth_*_test` database, never the development database.
- 43 web hook, stream-state, consent-recovery and chat-product tests passed in
  jsdom. They cover incremental display, turn replacement, completion, history,
  cancellation, fallback and reduced-motion changes.
- Web production build, API typecheck and lint on changed code passed.

## Real-provider observations

All requests used independent synthetic test accounts and synthetic messages.
The script verifies SSE ordering, response completion and fallback handling;
successful two-mode runs also check persistence, incognito separation and quota.
Synthetic conversations/contexts were cleaned up and sessions logged out.

The existing pre-change report recorded a persistent reply of 286 characters in
22 segments: first segment 5,769 ms, completion 22,050 ms. After batching, one
successful persistent turn returned 249 characters in 5 segments: first segment
7,917 ms, completion 13,097 ms. These are different generated replies and provider
runs, not a controlled latency benchmark or a promised speedup.

All three live smoke attempts did not fully pass. Attempt 1 fell back during
output classification; attempt 2 completed persistent chat but fell back during
incognito input classification. Attempt 3 completed a longer persistent reply
(591 characters, 10 segments, first segment 7,561 ms, completion 30,977 ms), then
also fell back during incognito input classification. The different response
length reinforces why a single faster run is not a general latency guarantee.
The first two reports are retained separately in ignored
`test-results/chat-smooth-live-attempt-1.json` and `-2.json`; the exact upstream
failure categories were not captured. Attempt 3 is recorded in
`test-results/chat-smooth-live-report.json`. A separate synthetic input-classification
probe completed in 6,113 ms, illustrating that first-response latency still
includes substantial remote classification time.

Local automated checks do not establish visual smoothness on the user's device,
real-model reliability, clinical suitability or production safety. Upstream
classification failures remain a separate unresolved reliability concern.
