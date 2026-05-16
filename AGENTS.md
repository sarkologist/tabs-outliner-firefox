# Repository Instructions

- Feel free to challenge assumptions and suggest a better way.
- When working on a new feature, use a feature branch, make incremental commits, and merge to `main` only when the user is satisfied.
- Use red-green TDD for behavior changes: write or update a failing test first, make it pass with the smallest change, then refactor if needed.
- For stateful, event-driven, or interleaving-heavy behavior, add deterministic property-style or generated trace tests that assert invariants across many operation sequences.
- For performance-related changes, profile or otherwise measure the relevant path before accepting the change. Record the scenario, command/tooling, and before/after numbers or trace observations in the commit, PR notes, or the relevant performance notes file.
