# Sidebar Startup Autoresearch

This is the local autoresearch setup for optimizing initial sidebar loading lag. It follows the spirit of `karpathy/autoresearch`: fixed metric, fixed run loop, small experiments, keep/discard by measurement.

## Setup

1. Choose a run tag based on today's date, for example `20260522`.
2. Create a fresh feature branch from `main`:
   `git switch -c codex/autoresearch-sidebar-startup-<tag>`.
3. Run the closed-heavy baseline:
   `pnpm run build`
   `pnpm profile:sidebar-startup -- --shape closed-heavy --tabs 50000 --live-tabs 50 --runs 3 --tag <tag> --description "closed-heavy baseline" --append-results`
4. Keep `autoresearch/sidebar-startup/results.tsv` and any `*.log` files untracked. They are local experiment output.

## Metric

Primary score: median `startup-initial-snapshot.totalWithHydrationMs` from `pnpm profile:sidebar-startup`.

The startup matrix models a large saved outline, not a browser with 50k open tabs. `--tabs` is the total number of tab nodes in the stored outline; `--live-tabs` is the small live browser frontier that must match the stored live nodes. The default startup shape is closed-heavy: 50 live tabs and the remaining tab nodes closed under one live window.

Profile shapes:

- `closed-heavy`: the original 50k tab-node startup loop. Use this to preserve comparability with earlier materialization and first-hydration runs.
- `order-page-heavy`: a nested 2026-05-26-calibrated storage shape with 19,433 tab nodes, 26,495 total nodes, and 7,062 parents with children. Use this before storage-read or order-page fanout experiments.
- `real-browser-20260526`: the order-page-heavy shape plus eight concurrent simulated sidebar boots, one sparse projection slice, and a five-event startup burst. Use this before accepting changes that might affect real multi-sidebar startup coordination. This scenario is diagnostic: one startup save is reported as a warning, while broadcasts and snapshot limits remain hard guards.

Guard metrics:

- `startup-stored-unchanged.totalMs`
- `startup-warm-initial-snapshot.totalMs`
- snapshot rows and nodes
- startup saves, broadcasts, and runtime event count
- Playwright first visible rows from `tests/playwright/sidebar-first-paint.spec.ts`

Keep an experiment only when the primary median improves by at least 10% or by at least 50ms, whichever is smaller, and no guard regresses.

## Experiment Loop

Repeat one hypothesis at a time:

1. Read the current matrix and pick the largest startup hydration cost.
2. Add or update a failing test first when changing behavior.
3. Make the smallest implementation change.
4. Run:
   `pnpm test -- src/perf/sidebar-startup-profile.test.ts src/perf/sidebar-startup-shapes.test.ts`
   `pnpm run build`
   `pnpm profile:sidebar-startup -- --shape closed-heavy --tabs 50000 --live-tabs 50 --runs 3 --tag <tag> --baseline-ms <baseline-primary-median> --description "<short idea>" --append-results`
   `pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --reporter=list`
5. If the result is `keep`, commit the code change with the metric summary in the commit message.
6. If the result is `discard`, reset only your experiment changes, leave the TSV row, and try the next hypothesis.

## Safety

- Do not increase the initial snapshot beyond 256 rows/nodes unless a separate deliberate metric-contract change is made first.
- Do not add startup saves, broadcasts, or runtime events to the startup scenarios.
- The `real-browser-20260526` shape intentionally processes five runtime events and may report startup saves as warnings; do not treat those warnings as acceptance for non-diagnostic shapes.
- Do not introduce full-state `stateUpdated` transport for first paint.
- If synthetic results disagree with real sidebar Playwright behavior or exported `tabsOutlinerProfile` traces, trust the real sidebar evidence.
