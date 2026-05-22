# Sidebar Startup Autoresearch

This is the local autoresearch setup for optimizing initial sidebar loading lag. It follows the spirit of `karpathy/autoresearch`: fixed metric, fixed run loop, small experiments, keep/discard by measurement.

## Setup

1. Choose a run tag based on today's date, for example `20260522`.
2. Create a fresh feature branch from `main`:
   `git switch -c codex/autoresearch-sidebar-startup-<tag>`.
3. Run the baseline:
   `pnpm run build`
   `pnpm profile:sidebar-startup -- --tabs 50000 --runs 3 --tag <tag> --description "baseline" --append-results`
4. Keep `autoresearch/sidebar-startup/results.tsv` and any `*.log` files untracked. They are local experiment output.

## Metric

Primary score: median `startup-initial-snapshot.totalWithHydrationMs` from `pnpm profile:sidebar-startup`.

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
   `pnpm test -- src/perf/sidebar-startup-profile.test.ts`
   `pnpm run build`
   `pnpm profile:sidebar-startup -- --tabs 50000 --runs 3 --tag <tag> --baseline-ms <baseline-primary-median> --description "<short idea>" --append-results`
   `pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --reporter=list`
5. If the result is `keep`, commit the code change with the metric summary in the commit message.
6. If the result is `discard`, reset only your experiment changes, leave the TSV row, and try the next hypothesis.

## Safety

- Do not increase the initial snapshot beyond 256 rows/nodes unless a separate deliberate metric-contract change is made first.
- Do not add startup saves, broadcasts, or runtime events to the startup scenarios.
- Do not introduce full-state `stateUpdated` transport for first paint.
- If synthetic results disagree with real sidebar Playwright behavior or exported `tabsOutlinerProfile` traces, trust the real sidebar evidence.
