# ADR-024: Restore the approved eight-cat mood check-in

- Status: Accepted
- Date: 2026-09-14
- Authorization: the user supplied the approved Mood page and requested restoration of its eight named cats, latest-per-day trajectory, and history instead of the migrated five-point UI.
- Partially supersedes ADR-017's mandatory score and average-based presentation, and ADR-023's statement that Mood retains only the five-point contract. All identity, ownership, consent, retention, concurrency, and client-storage boundaries remain unchanged.

## Decision

New check-ins store the selected `catMood` directly: happy, sad, angry, surprised, shy, sleepy, hopeful, or relaxed. No numerical mood is inferred from a cat, free text, or another data source. `moodScore` becomes nullable; at least a valid cat or a legacy score is required. Existing scores and emotion codes remain intact, and existing API clients can still submit them. Editing a legacy note preserves its original values unless the user explicitly selects a cat.

Seven/thirty-day history keeps Asia/Shanghai boundaries, server timestamps, owner scoping, frozen pagination, and one repeatable-read view per response. Each daily summary additionally returns the last check-in's cat/legacy fields, selected by `(created_at, id)` descending across the entire day, independent of the history page limit. The user-facing trajectory shows that actual last selection in chronological order. Legacy averages remain available to old clients and are null on days without scored check-ins; they do not determine cats.

Preserve the approved cream/sage palette and watercolor art: four columns of two rows on desktop, eight named moods, optional note, restrained hover motion, small daily cats, and plain-text history. Keep deletion confirmation, optimistic revisions, uncertain-write recovery, 500-code-point notes, session-memory cleanup, and no wellbeing content in browser storage, logs, or AI inputs.

## Validation

Review the additive migration (nullable old column, new checked cat column; no data rewrite), validate it on a separate test database before applying locally. Exercise eight-cat round trips, old records, latest-day results beyond pagination, boundaries, isolation, idempotency, and conflicts. Run nonvisual frontend tests and builds. The user explicitly owns all UI/motion acceptance; do not use computer-use or browser automation.
