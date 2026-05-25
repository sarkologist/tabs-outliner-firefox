# Sidebar Projection Hunt Guide

This guide is the mutation prompt for sidebar projection/hydration discovery. It is separate from runtime reconciliation trace hunting.

## Scope

- Use neutral `psh-*` scenario IDs for discovery.
- Record distinct findings as `PT-*` entries in `SIDEBAR_PROJECTION_BUGS.md`.
- Do not mutate fixed runtime `rt-*`, `bh-*`, `ph-*`, `lh-*`, `hh-*`, `jh-*`, `nh-*`, or `mh-*` traces.
- Do not fix bugs during projection discovery.

## Threat Model

Stress the boundary between a partial projected tree and the real sidebar:

- delayed, failed, stale, or out-of-order `getTreeProjectionSlice` responses;
- full `getState` hydration racing scroll, hover, command clicks, and patches;
- visible controls that require projection coverage to be truthful;
- compact patches arriving for rows that are hovered, visible, unloaded, or just deleted;
- restored or closed rows whose actions need authoritative full-state preflight;
- scroll jumps that should not leave the viewport blank or require a second scroll.

## Coverage Targets

Current projection guard baseline after 2026-05-25 guard hardening:

- `pnpm perf:sidebar-projection-guard` passes with startup hover and sparse scroll-away profiles.
- Projection discovery corpus has 13 `psh-*` scenarios covering rejected/delayed/out-of-order slices, restored single-tab delete cleanup, hover action stability, sparse full-state hydration, and partial action policy.
- `PT-001` is open and frozen: `psh-scroll-rejected-slice-recovers-without-second-user-scroll`. Clone variants instead of mutating this scenario.

Next sparse cells:

- rejected slice retry/recovery;
- repeated scrollbar jumps with stale non-covering responses;
- full hydration while scrolled to a fetched projection slice;
- visible in-coverage commands while full hydration is pending;
- stale patches for hovered rows and deleted rows;
- snapshots with missing coverage metadata;
- search/show-in-tree while slice requests are pending;
- multi-sidebar interaction deferring hydration.

## Hunt Procedure

For each mutation block:

- Spend about five minutes of active adversarial work; runner wait time does not count.
- Read only this guide, current projection tests, and relevant sidebar/projection code before adding scenarios.
- Add or clone neutral `psh-*` Playwright scenarios.
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
