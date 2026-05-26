# Sidebar Projection Hunt Guide

This guide is the mutation prompt for sidebar projection/hydration discovery. It is separate from runtime reconciliation trace hunting.

Use [SIDEBAR_PROJECTION_HUNT_RUNBOOK.md](./SIDEBAR_PROJECTION_HUNT_RUNBOOK.md) for the procedure, stop rule, commands, and mutation-block accounting.

## Scope

- Use neutral `psh-*` scenario IDs for discovery.
- Record distinct findings as `PT-*` entries in `SIDEBAR_PROJECTION_BUGS.md`.
- Do not mutate fixed runtime `rt-*`, `bh-*`, `ph-*`, `lh-*`, `hh-*`, `jh-*`, `nh-*`, or `mh-*` traces.
- Do not fix bugs during projection discovery.

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
- Projection discovery corpus has 27 `psh-*` scenarios covering rejected/delayed/out-of-order slices, restored single-tab delete cleanup, hover action stability, sparse full-state hydration, sparse patch stability, remote search clear/show-in-tree slices, and partial action policy.
- Fixed findings are preserved as regression coverage in the `psh-*` corpus: `PT-001` through `PT-007`. Do not mutate those scenarios directly during discovery; clone variants with new neutral IDs.

Next sparse cells:

- rejected slice retry/recovery;
- repeated scrollbar jumps with stale non-covering responses;
- background broadcasts while scrolled to a fetched projection slice;
- stale query responses after search clear or query replacement;
- show-in-tree target slices when the target moved, was deleted, or has an ancestor patched while the request is pending;
- compact tree-structure patches that can be locally applied before falling back to remote slice refresh;
- visible in-coverage commands while full hydration is pending;
- stale patches for hovered rows and deleted rows;
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

Stop only after three full active mutation blocks find no new distinct projection bug.

## Fix Gate

A `PT-*` finding is not fixed until:

- its Playwright repro passes;
- related projection/hydration tests pass;
- `pnpm perf:sidebar-projection-guard` passes;
- any accepted budget movement is recorded in `PERFORMANCE_NOTES.md`.
