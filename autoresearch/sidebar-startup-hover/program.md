# Sidebar Startup Hover Autoresearch

This is the local autoresearch setup for sparse-startup hover and sparse idle behavior. Active-centered sparse snapshots show rows whose DOM `data-row-index` can be much larger than `projection.rows.length`, so pointer lookup can miss the visible row and clear hover feedback. Current guards also assert that a valid sparse startup does not automatically request full `getState` hydration after idle.

## Setup

1. Choose a run tag based on today's date, for example `20260522-hover`.
2. Work on a feature branch, for example `codex/autoresearch-sidebar-startup-hover-<tag>`.
3. Run the deterministic baseline:
   `pnpm profile:startup-hover`
4. Run the repeated loop when judging margin:
   `pnpm profile:startup-hover-loop -- --runs 5 --tag <tag> --description "<short idea>" --append-results`
5. Keep `autoresearch/sidebar-startup-hover/results.tsv` and any ad hoc result logs untracked.

## Metric

Primary score: `clearMissingRowCount` from the `startup-sparse-hover` console JSON emitted by `pnpm profile:startup-hover`.

Target: `clearMissingRowCount === 0` for the visible active sparse row while the sidebar remains sparse.

For the post-fix margin loop, the primary budgets are:

- `startup-sparse-first-paint.initialSnapshotRender.maxMs < 16`
- `startup-sparse-first-paint.actionButtons === 0`
- `startup-sparse-hover.hoverFrameDelay.maxMs < 8`
- `startup-sparse-hover.hoverFeedbackDelay.maxMs < 4`
- `startup-hover-sparse-idle.hydrationRequestsAfterIdle === 0`
- `startup-remote-interaction-sparse-idle.hydrationRequestsAfterIdle === 0`

Use [../CORRECTNESS_GUARDS.md](../CORRECTNESS_GUARDS.md) before accepting any experiment. Hover-only rendering changes normally use the sparse projection lane when they affect row coverage, action visibility, hydration timing, or compact patch rendering; pure pointer-measurement changes can record why no extra projection corpus was needed.

Baseline on 2026-05-22 from `cf6df3a` plus this setup:

- `targetVisible: true`
- `targetRowIndex: "40000"`
- `hydrationRequests: 0`
- `pointerOutcomes: ["clear-missing-row"]`
- `clearMissingRowCount: 1`
- `hoverFeedbackCount: 0`
- `hoverGuideCount: 0`

First accepted experiment on 2026-05-22:

- Hypothesis: sparse startup hover fails because rendered rows store absolute `VisibleTreeRow.index` values, while hover code reads `projection.rows[rowIndex]` as though the projection were dense.
- Change: resolve hover rows by `VisibleTreeRow.index`, with a dense array fast path and sparse scan fallback.
- Result from `pnpm profile:startup-hover`: `pointerOutcomes: ["hover-row"]`, `clearMissingRowCount: 0`, `hoverFeedbackCount: 1`, `hoverGuideCount: 1`, `sidebar.input.pointerDelay.maxMs: 0.2`, `sidebar.input.hoverFeedbackDelay.maxMs: 2.8`, and `sidebar.hoverGuide.maxMs: 1`.

Second accepted experiment on 2026-05-22:

- Hypothesis: remaining startup hover lag is full hydration competing with non-edit hover frames, not hover-guide JS work.
- Change: record `sidebar.input.hoverFrameDelay`; delay sparse startup full hydration start by 1000ms after pointer/scroll input; when hydration has already resolved, wait for pending hover frames and 120ms of input idle before replacing the sparse projection.
- Result from `pnpm profile:startup-hover`: the hydration-deferral guard reported `hydrationRequestsBeforeIdle: 0`, `hydrationRequestsAfterIdle: 1`, `sidebar.input.hoverFrameDelay.maxMs: 4.4`, and `sidebar.input.hoverFeedbackDelay.maxMs: 0.3`.

Third accepted experiment on 2026-05-22:

- Hypothesis: after hydration deferral, the remaining perceptible sparse-startup hover lag is the intentional rAF coalescing delay itself.
- Change: apply hover-guide updates immediately while the sidebar is hydrating a sparse projection; keep rAF coalescing for the full projection.
- Result from `pnpm profile:startup-hover`: sparse hover reported `sidebar.input.hoverFeedbackDelay.maxMs: 0.3` and `sidebar.input.hoverFrameDelay.maxMs: 1.7`; the hydration-deferral guard reported `sidebar.input.hoverFrameDelay.maxMs: 1.8`.

Fourth accepted experiment on 2026-05-22:

- Hypothesis: after cross-sidebar hydration and diagnostics are deferred, the remaining occasional sharp overlap is a late sibling sidebar's sparse first paint building the full inert row action surface.
- Change: sparse hydrating first paint renders only the row label/twisty surface; edit/action buttons appear after full hydration, matching the existing command guards that already block those actions during hydration.
- Single-run result from `pnpm exec playwright test tests/playwright/sidebar-startup-interaction-profile.spec.ts --grep "sparse first paint"`: `sidebar.render.initialSnapshot.maxMs` moved from 27.7ms with 1,280 action buttons to 6.8ms with 0 action buttons.

Fifth accepted experiment on 2026-05-26:

- Hypothesis: once export/import/search and sparse-safe row commands are background-backed, the sidebar should not pay the old delayed whole-tree hydration cost on every startup.
- Change: a usable sparse startup snapshot no longer schedules automatic full `getState` hydration. Full hydration remains available for fallback paths where the initial sparse snapshot is unusable.
- Result from `pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --grep "exports and imports|does not auto-hydrate"`: valid sparse startup, sparse search/clear, export, and import remained available with `hydrationRequests: 0` after the old idle window.

Guard metrics:

- `targetVisible` remains `true`.
- `initialSnapshotRequests` remains `1`.
- `treeHeight` remains roughly full-size for the 50k sparse snapshot.
- `pointerDelay.maxMs` stays below 16ms.
- After the fix, `hoverFeedbackDelay.maxMs` should stay below 16ms, `hoverFrameDelay.maxMs` should stay below 50ms for deterministic startup guards, and `hoverGuideCount` should be at least 1.
- The broader startup guard still applies: `pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --grep "paints an active-centered sparse snapshot"` must pass.

## Experiment Loop

Repeat one hypothesis at a time:

1. Read the current `startup-sparse-hover` JSON and identify the failure mode.
2. Add or update a failing behavior test first when changing behavior. For sparse hover fixes, that test should assert a visible sparse row can resolve to its `VisibleTreeRow` while the sidebar remains sparse.
3. Make the smallest implementation change.
4. Run:
   `pnpm run build`
   `pnpm profile:startup-hover`
   `pnpm profile:startup-hover-loop -- --runs 5 --tag <tag> --description "<short idea>" --append-results`
   `pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --grep "paints an active-centered sparse snapshot"`
5. Keep the experiment only if `clearMissingRowCount` reaches 0, hover feedback appears for the visible sparse row, the repeated loop status is `keep`, and guards do not regress.
6. If the result is worse or ambiguous, revert only the experiment changes and try the next hypothesis.

## Safety

- Do not expand the sparse startup snapshot beyond 256 rows/nodes for this fix.
- Do not start full hydration just to make hover work.
- Do not add full-state transport, saves, broadcasts, or runtime events to the first-paint path.
- Do not hide row actions or defer hydration in a way that bypasses sparse command authority checks; action visibility and command guards must remain covered by projection scenarios.
- If this deterministic profile disagrees with an exported real `tabsOutlinerProfile`, trust the real profile and update this target to reproduce the missing behavior.
