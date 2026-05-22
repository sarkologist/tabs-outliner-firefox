# Sidebar Startup Hover Autoresearch

This is the local autoresearch setup for the sparse-startup hover glitch: after first paint, active-centered sparse snapshots show rows whose DOM `data-row-index` can be much larger than `projection.rows.length`, so pointer lookup can miss the visible row and clear hover feedback until full hydration completes.

## Setup

1. Choose a run tag based on today's date, for example `20260522-hover`.
2. Work on a feature branch, for example `codex/autoresearch-sidebar-startup-hover-<tag>`.
3. Run the deterministic baseline:
   `pnpm profile:startup-hover`
4. Keep any ad hoc result logs untracked.

## Metric

Primary score: `clearMissingRowCount` from the `startup-sparse-hover` console JSON emitted by `pnpm profile:startup-hover`.

Target: `clearMissingRowCount === 0` for the visible active sparse row before full hydration.

Baseline on 2026-05-22 from `cf6df3a` plus this setup:

- `targetVisible: true`
- `targetRowIndex: "40000"`
- `hydrationRequests: 0`
- `pointerOutcomes: ["clear-missing-row"]`
- `clearMissingRowCount: 1`
- `hoverFeedbackCount: 0`
- `hoverGuideCount: 0`

Guard metrics:

- `targetVisible` remains `true`.
- `initialSnapshotRequests` remains `1`.
- `treeHeight` remains roughly full-size for the 50k sparse snapshot.
- `pointerDelay.maxMs` stays below 16ms.
- After the fix, `hoverFeedbackDelay.maxMs` should stay below 16ms and `hoverGuideCount` should be at least 1.
- The broader startup guard still applies: `pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --grep "paints an active-centered sparse snapshot"` must pass.

## Experiment Loop

Repeat one hypothesis at a time:

1. Read the current `startup-sparse-hover` JSON and identify the failure mode.
2. Add or update a failing behavior test first when changing behavior. For the expected fix, that test should assert a visible sparse row can resolve to its `VisibleTreeRow` before full hydration.
3. Make the smallest implementation change.
4. Run:
   `pnpm run build`
   `pnpm profile:startup-hover`
   `pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --grep "paints an active-centered sparse snapshot"`
5. Keep the experiment only if `clearMissingRowCount` reaches 0, hover feedback appears for the visible sparse row, and guards do not regress.
6. If the result is worse or ambiguous, revert only the experiment changes and try the next hypothesis.

## Safety

- Do not expand the sparse startup snapshot beyond 256 rows/nodes for this fix.
- Do not start full hydration earlier just to make hover work.
- Do not add full-state transport, saves, broadcasts, or runtime events to the first-paint path.
- If this deterministic profile disagrees with an exported real `tabsOutlinerProfile`, trust the real profile and update this target to reproduce the missing behavior.
