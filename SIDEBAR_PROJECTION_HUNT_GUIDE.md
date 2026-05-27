# Sidebar Projection Hunt Guide

This guide is the mutation prompt for sidebar projection/hydration discovery. It is separate from runtime reconciliation trace hunting.

Use [SIDEBAR_PROJECTION_HUNT_RUNBOOK.md](./SIDEBAR_PROJECTION_HUNT_RUNBOOK.md) for the procedure, stop rule, commands, and mutation-block accounting.

## Scope

- Use neutral `psh-*` scenario IDs for discovery.
- Record distinct findings as `PT-*` entries in `SIDEBAR_PROJECTION_BUGS.md`.
- Do not mutate fixed runtime `rt-*`, `bh-*`, `ph-*`, `lh-*`, `hh-*`, `jh-*`, `nh-*`, or `mh-*` traces.
- Do not fix bugs during projection discovery. Finding a bug resets the clean-block count; fixes start only after the hunt stops under the usual stop rules.

## Threat Model

Stress the boundary between the background-owned outline and sidebars that now behave as remote projection clients:

- delayed, failed, stale, or out-of-order `getTreeProjectionSlice` responses;
- query-aware and target-node projection slices racing search clear, show-in-tree, and sparse scroll requests;
- sparse row-window state racing scroll, hover, command clicks, and patches;
- visible controls that require projection coverage to be truthful;
- compact patches arriving for rows that are hovered, visible, unloaded, or just deleted;
- restored or closed rows whose actions need authoritative full-state preflight;
- compact command acks/broadcasts that should patch visible rows before falling back to a background slice;
- scroll jumps that should not leave the viewport blank or require a second scroll.

## Coverage Targets

Current projection guard baseline after 2026-05-26 remote-projection work:

- `pnpm perf:sidebar-projection-guard` passes with startup hover and sparse scroll-away profiles. Startup-hover now guards sparse idle behavior with `sparseIdleActionButtonsMin` and `sparseIdleHydrationRequestsMax`; startup-scroll-away still requires viewport row coverage with `hydrationRequestsMax=0`.
- Projection discovery corpus has 83 `psh-*` scenarios covering rejected/delayed/out-of-order slices, restored single-tab delete cleanup, hover action stability, sparse full-state hydration, sparse patch stability, sparse delete/refill behavior, covered sparse edit controls, remote search clear/show-in-tree slices, search query replacement, full-state broadcast freshness, command/delete broadcast ordering, temporal scroll/search/clear ordering, coverage transitions, rejected response handling, partial action policy, edit/history command ordering, drag/drop while partial, stale search/scroll timing, history-status/show-in-tree ordering, full-hydration edit recovery, rejected response recovery, background patch updates during active search, target-node/show-in-tree intent replacement, rejected current target/query responses, missing target coverage metadata, and multi-sidebar search/scroll independence.
- Fixed findings are preserved as regression coverage in the `psh-*` corpus: `PT-001` through `PT-021`. Do not mutate those scenarios directly during discovery; clone variants with new neutral IDs.
- The 2026-05-26 edit/history hunt stopped after three clean active mutation blocks following `PT-015`; a toolbar undo/show-in-tree suspicion was retracted when the repro passed and stayed as coverage. The `PT-014`/`PT-015` fix pass converted both stale-intent repros to required-passing tests, so later hunts should treat those exact signatures as duplicate fixed regressions.
- The 2026-05-26 target-intent hunt recorded findings `PT-016` through `PT-021`, then stopped after three clean active mutation blocks following `PT-021`. The follow-up owner/coverage fix pass converted those repros to required-passing tests. The final clean discovery blocks sampled clear-search in one sidebar while another keeps search, rapid query replacement in one sidebar while another keeps search, and clear-search plus an already-painted sparse scroll in separate sidebars.

Next sparse cells:

- variants around the fixed target-intent owner model, especially owner replacement during rejected target/query responses, reveal target preservation after refills, missing coverage action gating, and background-patch handling while sparse scroll is pending;
- rejected slice retry/recovery;
- repeated scrollbar jumps with stale non-covering responses;
- background broadcasts while scrolled to a fetched projection slice;
- stale query responses after search clear or query replacement, especially when combined with rejected responses, background patches, remembered non-search projection fallback, or a newer projection intent;
- partial search result pruning after background patches, especially count/chrome metadata derived from background projection versus sidebar-local state;
- show-in-tree target slices when the target moved, was deleted, or has an ancestor patched while the request is pending, especially successful responses that no longer contain the requested target;
- rejected show-in-tree target slices, especially whether cleared-search intent restores non-search chrome without reusing stale search projection state;
- rejected clear-search slices, especially whether cleared-search intent restores non-search chrome without reusing stale search projection state;
- compact tree-structure patches that can be locally applied before falling back to remote slice refresh, especially deletes that shrink the current sparse window and must refill exposed viewport rows;
- visible in-coverage commands while full hydration is pending;
- covered edit controls while full hydration is pending, especially Cut, Paste, Move to top level, drag/drop, and which ones need background/full-state placement;
- missing-coverage snapshots after full hydration or full broadcasts, especially whether actions and edit affordances become available again;
- stale patches for hovered rows and deleted rows;
- undo/redo command ack ordering while only sparse projection state is present;
- stale non-search scroll slices racing newer search intent, target-node intent, or rapid query replacement;
- temporal undo/search/clear/background-patch ordering near the fixed `PT-014`/`PT-015` signatures, especially variants involving rejected current-intent responses or target-node projection requests;
- toolbar history commands while show-in-tree target projection requests are pending;
- snapshots with missing coverage metadata;
- search/show-in-tree while slice requests are pending;
- multi-sidebar startup with no automatic sidebar full hydration.

## Hunt Procedure

For each mutation block:

- Spend about five minutes of active adversarial work; runner wait time does not count.
- Read only this guide, current projection tests, and relevant sidebar/projection code before adding scenarios.
- Add or clone neutral `psh-*` Playwright scenarios.
- Prefer protocol-level assertions when testing remote projection behavior: captured `query`, `targetNodeId`, request order, DOM visibility, and absence of unexpected `getState` hydration.
- Run `pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --reporter=list`.
- Record every distinct failure in `SIDEBAR_PROJECTION_BUGS.md` before mutating scenarios again.
- Freeze failing scenarios; clone variants with new IDs.

Stop only after three full active mutation blocks find no new distinct projection bug. Count those clean blocks after the most recent new finding.

## Fix Gate

A `PT-*` finding is not fixed until:

- its Playwright repro passes;
- related projection/hydration tests pass;
- `pnpm perf:sidebar-projection-guard` passes;
- any accepted budget movement is recorded in `PERFORMANCE_NOTES.md`.
