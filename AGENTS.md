# Repository Instructions

- Feel free to challenge assumptions and suggest a better way.
- When working on a new feature, use a feature branch, make incremental commits, and merge to `main` only when the user is satisfied.
- Use red-green TDD for behavior changes: write or update a failing test first, make it pass with the smallest change, then refactor if needed.
- For browser UI behavior, prefer Playwright tests that drive the real built extension/UI with deterministic fixtures. Run them with `pnpm exec playwright test`.
- In Playwright coverage, assert both visible behavior and app/runtime state where practical: DOM/accessibility state, console errors, failed network requests, tree invariants, persisted state, and `tabsOutlinerProfile` traces when relevant.
- Keep browser automation stable and inspectable: use semantic roles or `data-testid` selectors for important controls, capture screenshots for layout-sensitive changes, and avoid timing-only waits when a state or event assertion is available.
- For stateful, event-driven, or interleaving-heavy behavior, add deterministic property-style or generated trace tests that assert invariants across many operation sequences.
- When investigating soak failures, treat random soak as complementary to targeted hunts: use the failing seed to expose accidental cross-products, then promote real bugs to frozen regressions or update the broader threat model only if the failure reveals a general architectural gap.
- When oracle-backing a new runtime trace class, state the intended invariant first and add small domain traces with expected behavior before broad generated replay gates. If the PureScript oracle diverges from TS, decide independently whether TS or the oracle is wrong; do not expand the oracle merely to mirror current TS behavior.
- For performance-related changes, profile or otherwise measure the relevant path before accepting the change. Record the scenario, command/tooling, and before/after numbers or trace observations in the commit, PR notes, or `PERFORMANCE_NOTES.md`.
- When performance work changes algorithmic shape, transport shape, save timing, or runtime/sidebar patch behavior, update the `Current Asymptotics Audit` table in `PERFORMANCE_NOTES.md`, or explicitly note that the table is unchanged.
- Use realistic measurements for performance work. Synthetic `pnpm profile:*` runs are good for repeatability, but if they disagree with manual QA, add or inspect an in-browser `tabsOutlinerProfile` trace before choosing the next target.
- Separate perceived latency from eventual persistence. Prefer visible broadcasts/patches on the interaction path and defer/coalesce full storage saves when correctness allows it.
- Avoid full-state transport and full sidebar renders for small changes. Prefer compact semantic patches (`nodeStateUpdated`, `treeStructureUpdated`, `activeStateUpdated`) and reserve full `stateUpdated` for compatibility or genuinely whole-tree-sized changes.
- Preserve object identity for unchanged outline nodes when practical, filter no-op/stale browser events, and absorb command-owned runtime echoes before they trigger saves, broadcasts, diagnostics, or projection rebuilds.
- When replacing a full render with an incremental patch, audit the side effects that used to happen during `render()`: active-tab scrolling, counters, empty states, rename/drop cleanup, diagnostics scheduling, and virtual-row refresh.
