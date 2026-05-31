# Sidebar Projection Hunt Guide

This guide is the mutation prompt for sidebar projection/hydration discovery. It is separate from runtime reconciliation trace hunting.

Use [SIDEBAR_PROJECTION_HUNT_RUNBOOK.md](./SIDEBAR_PROJECTION_HUNT_RUNBOOK.md) for the procedure, stop rule, commands, and mutation-block accounting.

## Scope

- Use neutral `psh-*` scenario IDs for discovery.
- Record distinct findings as `PT-*` entries in `SIDEBAR_PROJECTION_BUGS.md`.
- Do not mutate fixed runtime `rt-*`, `bh-*`, `ph-*`, `lh-*`, `hh-*`, `jh-*`, `nh-*`, or `mh-*` traces.
- Do not fix bugs during projection discovery. Finding a bug resets the clean-block count; fixes start only after the hunt stops under the usual stop rules.
- If proposal subagents or scouts are used, close/remove them after collecting their output or when the hunt stops, and include that cleanup in the final hunt accounting.

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

Current projection guard baseline after the 2026-05-27 collapsed-boundary fix pass:

- `pnpm perf:sidebar-projection-guard` passes with startup hover and sparse scroll-away profiles. Startup-hover now guards sparse idle behavior with `sparseIdleActionButtonsMin` and `sparseIdleHydrationRequestsMax`; startup-scroll-away still requires viewport row coverage with `hydrationRequestsMax=0`.
- Projection discovery corpus has 205 `psh-*` scenarios covering rejected/delayed/out-of-order slices, sparse full-state hydration, compact patch/refill behavior, covered and missing-coverage action truth, remote search clear/show-in-tree slices, owner replacement, target-node freshness, stale search/scroll timing, edit/history command ordering, multi-sidebar owner independence, covered sparse drag/drop before full hydration, sparse-local hover/rename/keyboard/drag/drop/focus/close/delete interactions, cut/paste recovery, restore/delete shells, command-to-search/target replacement, missing-coverage drag recovery after covered refill, restored-tab root drops, rename-to-show-in-tree replacement, cross-sidebar boundary drag plus target reveal fanout, delayed closed-restore scopes, keyboard undo/redo against query and target replacement, restore-dialog independence across sidebars, and collapsed-boundary search/show-in-tree/drag/drop/refill behavior.
- Fixed findings are preserved as regression coverage in the `psh-*` corpus: `PT-001` through `PT-031` and `PT-033` through `PT-037`; the suspected `PT-032` rename/search issue was retracted and its scenarios now pass as stale-refill-before-search coverage. Do not mutate fixed scenarios directly during discovery; clone variants with new neutral IDs.
- The 2026-05-26 edit/history hunt stopped after three clean active mutation blocks following `PT-015`; a toolbar undo/show-in-tree suspicion was retracted when the repro passed and stayed as coverage. The `PT-014`/`PT-015` fix pass converted both stale-intent repros to required-passing tests, so later hunts should treat those exact signatures as duplicate fixed regressions.
- The 2026-05-26 target-intent hunt recorded findings `PT-016` through `PT-021`, then stopped after three clean active mutation blocks following `PT-021`. The follow-up owner/coverage fix pass converted those repros to required-passing tests. The final clean discovery blocks sampled clear-search in one sidebar while another keeps search, rapid query replacement in one sidebar while another keeps search, and clear-search plus an already-painted sparse scroll in separate sidebars.
- The 2026-05-27 patch/refill owner-fanout hunt recorded `PT-022` through `PT-030`; the follow-up projection-frame fix closed row, owner, chrome metadata, coverage, and fallback-memory drift. Manual QA then found `PT-031`, where the old full-hydration drag/drop guard blocked covered local drag/drop; the follow-up fix made row/root drag/drop coverage-aware and missing coverage request a sparse refill instead of `getState`.
- The 2026-05-27 sparse-local interaction hunt added 14 scenarios across hover/action inventory, rename isolation, keyboard cut, drag/drop/root-drop preview cleanup, focus/close/delete stale refills, and two-sidebar search/show-in-tree fanout. It stopped after three clean active mutation blocks with no new `PT-*` findings.
- The 2026-05-27 sparse action follow-up hunt added 18 scenarios across cut/paste hydration recovery, move-to-root stale refill cleanup, restore/delete shell cleanup, drag-preview search replacement, rename/search replacement, close/search replacement, closed/restored delete fanout, and two-sidebar target/search/clear-search independence. A suspected `PT-032` for rename/search replacement was retracted after the follow-up pass showed the repro had resolved a stale outline refill but not the later debounced search request. The corrected rename scenarios are required-passing coverage.
- The 2026-05-27 sparse boundary hunt added 7 scenarios across covered boundary row drag/drop, missing-coverage drag/drop refill and recovery, restored-tab root drop, rename Escape/Enter crossing show-in-tree target replacement, and two-sidebar local drag plus target reveal independence. It stopped after three clean active mutation blocks with no new `PT-*` findings.
- The 2026-05-27 restore/keyboard/temporal hunt added 15 scenarios across delayed closed-restore scopes, restored/delete shells, keyboard cut/paste/undo/redo while query or show-in-tree ownership is changing, and two-sidebar restore/search/target independence. It found `PT-033`, `PT-034`, and `PT-035`, then stopped after three clean active mutation blocks with no further distinct projection signatures. The follow-up fix passes closed stale restore-scope admission, pending target-owner loss under history/title patches, and delayed restore-scope prompts after locally known scoped children are deleted.
- The 2026-05-27 collapsed-boundary hunt added 21 scenarios across collapsed ancestor drag/drop coverage, hidden-child search/show-in-tree, stale clear-search, hidden-child title/delete patches, parent delete, mid-drag collapse cleanup, full-broadcast target/search preservation, move-before-target reveal, and multi-sidebar collapse/search independence. It found `PT-036` and `PT-037`, then stopped after three clean active mutation blocks with no further distinct projection signatures. The follow-up fix pass closed missing collapsed-parent child-order coverage refill and expanded hidden-child row refill by allowing forced current-owner refills for hydrating partial projections while keeping tree-structure patches local.

Next sparse cells:

- deeper collapsed-boundary temporal heat such as stale full broadcasts, move/reorder under hidden children, loaded/unloaded child-list transitions, and repeated expand/collapse while sparse coverage is being refilled;
- restore/reopen workflows for closed rows while coverage is partial or recently refilled, beyond the fixed stale restore-scope prompt case;
- keyboard shortcuts crossing search/show-in-tree replacement while rename, drag, or cut state is active, beyond the fixed target-owner loss under history/title patches;
- multi-sidebar startup with no automatic sidebar full hydration, especially one sidebar editing locally while another owns search/show-in-tree/scroll;
- temporal heat across local action, stale sparse response, compact patch, command ack/history status, full broadcast, and follow-up viewport refill.

## Hunt Procedure

For each mutation block:

- Spend about five minutes of active adversarial work; runner wait time does not count.
- Read only this guide, current projection tests, and relevant sidebar/projection code before adding scenarios.
- Add or clone neutral `psh-*` Playwright scenarios.
- Prefer protocol-level assertions when testing remote projection behavior: captured `query`, `targetNodeId`, request order, DOM visibility, preserved `scrollTop` / viewport row window, and absence of unexpected commands or `getState` hydration.
- Treat scroll, focus, command sends, and full-state hydration as side-effect oracles. Passive sparse hydration, stale slice replacement, and remote patch/broadcast handling must not move the viewport unless the action explicitly requested reveal/show-in-tree/active-tab reveal.
- Browser active-tab create/duplicate/detach scenarios should assert the requested target row and final `scrollTop`, not only that the row eventually appears.
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
