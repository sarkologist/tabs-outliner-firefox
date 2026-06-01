# Sidebar Drag/Drop Autoresearch

This is the local autoresearch setup for improving large-outline drag/drop latency. It follows the existing project loop: fixed metric, fixed run command, small experiments, keep or discard by measured browser behavior.

## Setup

1. Choose a run tag based on today's date, for example `20260601-drag-drop`.
2. Work on `codex/autoresearch-drag-drop-20260601` or another feature branch.
3. Run the deterministic baseline:
   `pnpm run build`
   `pnpm profile:drag-drop -- --runs 5 --tag <tag> --description "baseline" --append-results`
4. For experiments, pass the baseline median:
   `pnpm profile:drag-drop -- --runs 5 --tag <tag> --baseline-ms <baseline-drop-median-ms> --description "<short idea>" --append-results`
5. Keep `autoresearch/sidebar-drag-drop/results.tsv` and ad hoc logs untracked.

## Metric

Primary score: median `drag-drop-50k-drop.elapsedMs` from `tests/playwright/sidebar-drag-drop-performance.spec.ts`.

The Playwright profile drives the real sidebar with a 50,000-tab fixture, starts a drag, drops a leaf before the first visible tab, waits for the visible row order to update, and reads `tabsOutlinerProfile` summary rows.

Target budgets:

- `dropMaxMs < 90`
- `dropTreePatchMaxMs < 12`
- `dropVirtualRowsMaxMs < 16`
- `dropProjectionBuildCount === 0`
- `dragoverP95MaxMs < 8`
- `hoverGuideMaxMs < 8`
- `hoverScrollVirtualRowsMaxMs < 16`
- no console errors, page errors, or failed requests in the underlying Playwright tests

Keep an experiment only when all guards pass and the median drop latency improves by at least 10% or 5ms from the supplied baseline, whichever is smaller. Baseline runs without `--baseline-ms` are kept if the guards pass.

## Experiment Loop

Repeat one hypothesis at a time:

1. Read the JSON summary and attached Playwright profile output.
2. Add or update a failing behavior or profiler test first when changing behavior.
3. Make the smallest implementation change.
4. Run:
   `pnpm test -- src/perf/drag-drop-profile.test.ts`
   `pnpm run build`
   `pnpm profile:drag-drop -- --runs 5 --tag <tag> --baseline-ms <baseline-drop-median-ms> --description "<short idea>" --append-results`
5. If the result is `keep`, commit the code change with the metric summary.
6. If the result is `discard`, revert only the experiment changes, leave the TSV row, and try the next hypothesis.

First experiment order:

1. Baseline only, no app changes.
2. If `sidebar.virtualRows` dominates, prototype a narrower visible-row update for same-parent leaf reorders.
3. If `sidebar.patch.treeStructure` dominates, optimize same-parent reorder lookup work in `visible-tree`.
4. If mocked command time dominates, investigate the background `moveNode` path while preserving the one-tab `moveTabs` batch behavior.

## Safety

- Use the Playwright profile as the source of truth for browser-visible drag/drop latency.
- Keep `pnpm profile:command -- --tabs 50000 --scenario move-leaf` as a synthetic cross-check only.
- Do not add this heavy browser loop to the default sidebar projection guard until it proves stable.
- Do not reintroduce full `stateUpdated` transport or full sidebar projection rebuilds on the common same-window leaf drop path.
- If synthetic results disagree with exported `tabsOutlinerProfile` traces, trust the real browser trace and update this target to reproduce the missing behavior.
