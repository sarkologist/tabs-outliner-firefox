# Background Reconciliation Autoresearch

Run tag: `20260602-background-reconcile`

## Goal

Reduce structural-command latency after background commands, especially save flush time and runtime-event reconciliation. Synthetic command profiles are the iteration harness; exported `tabsOutlinerProfile` JSON is the real-world cross-check and wins if the two disagree.

## Baseline

```sh
pnpm run build
pnpm profile:background-reconciliation -- --runs 5 --tag 20260602-background-reconcile --description "baseline" --append-results
```

The primary score is the worst scenario median `totalWithSaveFlushMs` across:

- `move-leaf`
- `group-live-leaf`
- `move-top-level-live-leaf`

Record the baseline summary JSON and use its primary median as `--baseline-ms` for experiments. When comparing guard metrics against baseline, pass the saved JSON with `--baseline-summary <path>`.

## Experiment Command

```sh
pnpm run build
pnpm profile:background-reconciliation -- --runs 5 --tag 20260602-background-reconcile --description "<idea>" --baseline-ms <primary_median_ms> --baseline-summary <baseline_summary.json> --append-results
```

The profiler reports `candidate-keep` when the primary median improves by at least `min(10%, 50ms)` and its local guards pass. Promote that candidate only through the correctness wrapper:

```sh
pnpm autoresearch:accept -- --lanes runtime --tag 20260602-background-reconcile --description "<idea>" --append-results -- pnpm profile:background-reconciliation -- --runs 5 --tag 20260602-background-reconcile --description "<idea>" --baseline-ms <primary_median_ms> --baseline-summary <baseline_summary.json>
```

Keep an experiment only when the wrapper reports final `keep`.

Do not stop the overall autoresearch loop after one discard. Continue to the next experiment until there have been 3 consecutive discarded experiments after the latest keep.

## Guards

Use [../CORRECTNESS_GUARDS.md](../CORRECTNESS_GUARDS.md) before accepting any experiment. This loop always touches the runtime/background lane; run the runtime regression trace corpus, and run focused trace IDs first when the experiment changes command-created windows, browser-created tabs, relocation, close/restore, history, restart, or runtime ordering.

- `ack.stateChanged === true` for every structural command.
- Expected node count/root shape per scenario.
- No full `stateUpdated` broadcast for structural patch scenarios.
- `sameParentReorderUpdated` is preserved for `move-leaf`.
- `saveFlushMs` does not increase versus baseline for any scenario.
- `storageSetCalls <= baseline`.
- `stateSaves <= baseline`.
- `eventEchoMs <= baseline + 25ms`.
- `background.runtime.getWindows` count/max do not increase when trace is enabled.
- `move-leaf` has no synthetic projection rebuild: `projectionMs === 0` and `treePatchMs === 0`.

## First Experiment Order

1. Baseline only, no app changes.
2. If `saveFlushMs` dominates, optimize pending save candidate tracking and v3 save diffing for structural commands.
3. If `refreshFromRuntime` or `runtime.getWindows` dominates, improve command-owned echo absorption for `wrapNodeInGroup` and `moveSubtreeToTopLevel`.
4. If sidebar fanout dominates after background work improves, reduce full `treeStructureUpdated` handling across multiple sidebars.
5. Ignore `sidebar.diagnostics.defer` unless a real diagnostics CPU entry, not timer delay, is the measured blocker.

## Cross-Checks

```sh
PROFILE_BACKGROUND_TRACE=1 pnpm profile:command -- --tabs 50000 --scenario group-live-leaf
PROFILE_BACKGROUND_TRACE=1 pnpm profile:command -- --tabs 50000 --scenario move-top-level-live-leaf
```

Before and after kept app changes, parse the latest exported profile, especially `dist/tabs-outliner-profile-2026-06-02.json`, and report totals for `background.state.save`, `refreshFromRuntime`, `background.runtime.getWindows`, runtime events, and sidebar fanout.

Do not keep a runtime fast-path optimization solely because the background reconciliation profile improves. If a focused runtime replay fails in the touched blast radius, fix that finding or discard/move the optimization.
