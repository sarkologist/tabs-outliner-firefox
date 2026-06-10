# Autoresearch Correctness Guards

Performance autoresearch can only keep an experiment when the optimized path still satisfies the relevant correctness corpus. Perf counters are not a substitute for these checks.

## Choose The Lane

Pick every lane touched by the experiment:

- Runtime/background lane: background commands, runtime event fast paths, runtime facts, window scopes, history replay, close/restore/delete, persistence, or browser reconciliation.
- Sparse projection lane: sidebar sparse startup, remote search/projection, sparse coverage, row actions, restore preflight, hydration, scroll, hover, drag/drop, or compact sidebar patches.
- Storage/import lane: state load/save layout, import/export persistence, v4 shards/manifests (and legacy v3/v2 reading), or startup durability.
- Storage-fault lane: **mandatory for any experiment that changes save timing or save shape** — journal append points, event-journal coalescing, compaction triggers, deferral schedules, or checkpoint conditions. This is the class of change that historically traded crash-loss windows for latency without a gate noticing.

If a change crosses lanes, run all relevant lane guards. Do not mark an experiment `keep` while an open finding in the touched lane is still reproducible unless the experiment explicitly fixes that finding.

## Acceptance Wrapper

Profiler loops report `candidate-keep` when their perf budgets pass. A candidate becomes a final `keep` only after `pnpm autoresearch:accept` runs the selected correctness lanes.

Run the profiler through the wrapper, selecting every touched lane:

```sh
pnpm autoresearch:accept -- --lanes runtime --tag <tag> --description "<idea>" --append-results -- pnpm profile:background-reconciliation -- --runs 5 --tag <tag> --description "<idea>" --baseline-ms <ms>
pnpm autoresearch:accept -- --lanes projection --tag <tag> --description "<idea>" --append-results -- pnpm profile:drag-drop -- --runs 5 --tag <tag> --description "<idea>" --baseline-ms <ms>
pnpm autoresearch:accept -- --lanes projection,storage --tag <tag> --description "<idea>" --append-results -- pnpm profile:sidebar-startup -- --shape closed-heavy --tabs 50000 --live-tabs 50 --runs 3 --tag <tag> --baseline-ms <ms> --description "<idea>"
```

The wrapper writes the final acceptance decision to `autoresearch/acceptance/results.tsv` when `--append-results` is present. Existing profiler TSV rows are perf evidence; the acceptance TSV owns final `keep` versus `discard-correctness`.

## Runtime/Background Lane

Required before keeping a runtime/background experiment:

```sh
pnpm run oracle:build
pnpm test
pnpm run build
RUNTIME_TRACE_HUNT_PROFILE=regression RUNTIME_TRACE_HUNT_BATCH_SIZE=50 pnpm trace-hunt:runtime
```

When the change touches runtime order, command-created windows, browser-created tabs, relocation, close/restore, history, restart, or closed-subtree persistence, also replay the focused IDs that exercise that blast radius before the broad regression run. Examples:

```sh
RUNTIME_TRACE_HUNT_TRACE_IDS=qh-escape-command-created-double-reorder-complete,yh-runbook-r1-created-race-command-cohabit pnpm trace-hunt:runtime
RUNTIME_TRACE_HUNT_TRACE_IDS=<changed-dl-or-regression-ids> pnpm trace-hunt:runtime
```

If the focused replay exposes an open finding, the perf experiment is not acceptable for that blast radius until the finding is fixed or the code change is moved outside the implicated path.

## Sparse Projection Lane

Required before keeping a sparse projection experiment:

```sh
pnpm run build
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --reporter=list --workers=1
pnpm perf:sidebar-projection-guard
```

For narrow sparse changes, run the focused `psh-*` IDs first, then the full corpus. Restore-preflight, search/clear, sparse patch, or command-action changes must include focused scenarios for stale query/target responses, delayed command acks, compact delete patches, and pending full hydration. Example:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-closed-child-restore-keeps-parent-preflight|psh-closed-tab-query-replacement-last-restore-target-wins" --reporter=list --workers=1
```

Known open projection findings block `keep` for overlapping changes. If the experiment changes the same path as an open `PT-*`, fix or explicitly avoid that path before accepting the perf result.

## Storage/Import Lane

Required before keeping storage/import experiments:

```sh
pnpm test -- src/background/storage-v2.test.ts
pnpm run build
pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --reporter=list
```

If the change can affect closed/restorable nodes, history recovery, import fallback, or startup save ordering, also run the runtime/background lane regression and the sparse projection lane scenarios that cover closed/imported rows.

## Storage-Fault Lane

Required before keeping any experiment that changes save timing or save shape (select with
`--lanes storage-faults`):

```sh
pnpm exec vitest run src/background/storage-v4.test.ts src/background/outline-journal.test.ts src/test/faulty-storage.test.ts -t "fault|torn|corrupt|crash|restart|fail|reject"
GENERATED_TRACE_SOAK=1 pnpm exec vitest run src/background/storage-v4.test.ts -t "crashes"
```

The first command replays the deterministic torn-write/failed-set/corrupt-slot/recovery-ladder
tests against the fault-injecting storage mock (`src/test/faulty-storage.test-support.ts`).
The second runs the generated mutate/journal/compact/fail/crash/restart property test at soak
scale (16 seeds x 400 steps by default; scale further with `GENERATED_TRACE_SEED_COUNT` /
`GENERATED_TRACE_STEPS` / `GENERATED_TRACE_BASE_SEED`); every simulated restart must
reproduce the in-memory model exactly (invariants I-1/I-2/I-3/I-5 in `INVARIANTS.md`).
`pnpm test:soak` also includes this property test, so the nightly soak exercises the fault
lane with fresh random seeds.

## Recording

For every kept experiment, record in the commit message, PR notes, or `PERFORMANCE_NOTES.md`:

- measured before/after metric;
- selected correctness lanes;
- exact trace/scenario IDs replayed;
- broad corpus command result;
- any open finding intentionally left unrelated to the touched path.
