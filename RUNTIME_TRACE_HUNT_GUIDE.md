# Runtime Trace Hunt Guide

This guide is the mutation prompt for domain-level runtime discovery. Use it before reading fixed repro histories. Treat `RUNTIME_TRACE_BUGS.md` as a post-run dedupe and evidence log, not as the source of new trace ideas.

## Corpus Roles

- `regression` traces preserve known RT/SS findings and run in ordinary `pnpm test`.
- `discovery` traces are neutral threat-model probes. Mutate these during the adversarial hunt.
- `known-finding` origins should not be used as discovery prompts.
- `threat-model` and `agent-generated` origins are the normal discovery inputs.

Run profiles:

```sh
pnpm trace-hunt:runtime
RUNTIME_TRACE_HUNT_PROFILE=regression pnpm trace-hunt:runtime
RUNTIME_TRACE_HUNT_PROFILE=all pnpm trace-hunt:runtime
RUNTIME_TRACE_HUNT_TRACE_IDS=dh-focus-session-activation-refresh pnpm trace-hunt:runtime
```

## Domain DSL

A trace is:

```ts
type RuntimeDomainTrace = {
  id: string;
  title: string;
  notes: string;
  purpose: "regression" | "discovery";
  origin: "known-finding" | "threat-model" | "agent-generated";
  tags: string[];
  coveredFindingIds?: string[];
  actions: DomainAction[];
};
```

Core selectors:

- Tabs: `tabById` via `{ tabId }`, captured tabs, `activeTab`, `firstRuntimeTab`, `lastOpenedTab`, `lastMovedTab`, or a tab in a selected window.
- Windows: `windowById` via `{ windowId }`, captured windows, `focusedWindow`, `firstRuntimeWindow`, or `lastOpenedWindow`.
- Stale tabs: named stale captures or `tabInOldWindow`.

Useful actions:

- Runtime events: `openTab`, `activateTab`, `updateTab`, `focusWindow`, `sessionChanged`, `manualRefresh`, `restartBackground`, `restartBackgroundAbrupt`.
- Commands: `outlinerGroupTab`, `outlinerMoveTabToNewWindow`, `outlinerMoveTabCommandToNewWindow`, `outlinerMoveSubtreeToTopLevel`, `outlinerFocusTab`, `outlinerCloseTab`, `outlinerCloseWindow`, `outlinerUndo`, `outlinerRedo`.
- Failure-shape commands: `outlinerDeleteWindowRejectingClose`, `outlinerDeleteTabRejectingClose`, `outlinerDeleteNodeRejectingClose`, `outlinerCloseNodeRejectingClose`, `outlinerMoveTabCommandToNewWindowRejectingCreate`, `outlinerFocusTabRejectingUpdate`, `outlinerRestoreNodeRejectingCreate`, `outlinerRestoreDeleteWindowDelayedEvent`.
- Query skews: `manualRefreshWithStaleQuery`, `manualRefreshWithMissingTabQuery`, `manualRefreshWithMissingWindowQuery`, `manualRefreshWithReorderedQuery`.
- Stale echoes: `staleLiveUpdatedEvent`, `staleLiveCreatedEvent`, `flushRuntimeEvents`.

`openTab` may include `openerTab` to model opener/reparenting behavior.
`nativeCloseWindow` may set `order` to `tabsRemovedThenWindowRemoved`, `windowRemovedThenTabsRemoved`, `windowRemovedOnly`, or `tabsRemovedOnly`.
`outlinerRestoreNodeRejectingCreate` may set `captureRestoredTabs` and `captureRestoredWindows`; these captures bind to current live runtime resources restored from the original closed outline node IDs, not historical tab/window IDs.
`restartBackground` flushes pending saves, recreates the background controller against the same fake runtime/storage, calls `ensureState`, and keeps named stale captures intact so delayed browser evidence can arrive after restart.
`restartBackgroundAbrupt` drops listeners and recreates the controller without flushing runtime events or pending saves. Use it only for crash-boundary traces where the durable lifecycle journal, not the ephemeral ledger, must recover confirmed browser side effects.

## Invariants

Every action is followed by the generated runtime invariants. The important classes are:

- live outline window IDs match live runtime window IDs;
- live outline tab IDs match live runtime tab IDs;
- live tab window ownership matches the runtime tab's current window;
- active flags agree with browser state;
- closed or deleted outline subtrees do not contain live runtime resources;
- stale event/query snapshots do not resurrect moved or removed runtime resources.

## Threat Model

Focus mutations on stale or contradictory evidence crossing command boundaries:

- a command moves, closes, restores, or deletes runtime resources while older browser events are still pending;
- `tabs.query` or session refresh returns a partial, stale, or reordered snapshot;
- window removal and tab removal events disagree about ownership;
- a command rejects after the runtime operation partially or fully happened;
- opener relationships move across windows or outlive their source window;
- undo/redo replays model history while runtime events from the old state still arrive.

## Coverage Matrix

Current coverage after the runtime lifecycle durability pass on 2026-05-24: 166 regression traces and 303 discovery traces. The restart-stress expansion recorded RT-063 through RT-090 and was promoted to regression coverage. The breadth sweep added neutral `bh-*` discovery traces, recorded RT-091 through RT-095 around restore create rejection side effects, and those five traces are now promoted to regression coverage after the recovery fix. The post-recovery sweep added neutral `ph-*` discovery traces and recorded RT-096 through RT-103; RT-096, RT-098, and RT-103 are promoted regression coverage, while the remaining RT-097/099/100/101/102 entries were harness artifacts corrected in discovery traces. The transaction-boundary sweep recorded RT-104 and RT-105 around history replay after recovered relocated closes; both are promoted regression coverage after the history replay fix. Crash-boundary focused tests now cover the durable journal for close, delete, restore, relocation, and history replay; discovery traces may use `restartBackgroundAbrupt` to probe similar edges.

| State shape | Command edge | Runtime skew | Refresh edge | Current coverage | Next target |
| --- | --- | --- | --- | --- | --- |
| flat windows | move tab to command window | stale old-window created/update | manual refresh | covered | keep as baseline only |
| grouped/nested windows | close parent or source window | window removed before/without tab removed | session/manual refresh | regression-covered after RT-044, RT-045, RT-046, RT-053, RT-054, and RT-055 | add deeper nesting and multi-tab ownership permutations |
| opener-linked tabs | move opened tab across windows | opener survives undo/redo | partial or reordered refresh | expanded and partially regression-covered | add opener chains and opener source-window deletion variants |
| closed/restored subtree | restore/delete/native close after restore | delayed restored-tab event or create rejection side effect crosses history/restart | stale, missing, or reordered query | regression-covered after RT-041, RT-042, RT-043, RT-056, RT-060, RT-062, and RT-091 through RT-095 | add restore plus native close and restore plus relocation rejection combinations |
| partial command failure | relocation/create rejects | runtime side effect already happened | stale/manual refresh | regression-covered after RT-048, RT-049, RT-057, and RT-059 | add side-effect rejection coverage outside create-window relocation |
| relocated/source-closed tabs | move or group tab, then source disappears | stale `tabs.query` old/source copy | manual refresh | regression-covered | avoid as primary prompt |
| relocated live tabs | moved tab remains live | partial `tabs.query` omits tab/window | manual refresh | regression-covered after RT-040, RT-047, RT-050, RT-051, RT-052, RT-058, and RT-061 | add missing-window snapshots for multi-window/multi-tab projections |
| focus churn | focus/activate during command | stale active or reordered snapshot | session/manual refresh | expanded | keep adding reorder-only and cross-window focus variants |
| history replay | undo/redo around live command | stale event from undone shape | manual refresh | regression-covered plus opener/restore expansion | keep combined with opener/restore only |
| ledger/restart lifecycle | command, focus, native, restore, or rejection facts cross background restart | stale event after ephemeral guards are gone | startup reconciliation plus partial/manual refresh | regression-covered after RT-063 through RT-090 plus clean current-evidence controls | next hunt should target novel restart shapes rather than enumerating fixed repro variants |

## Breadth Hunt Targets

Breadth expansion started from 134 regression traces and 121 discovery traces, then added neutral `bh-*` discovery traces. After promoting RT-091 through RT-095, the baseline is 139 regression traces and 167 discovery traces. Prefer new qualitative cells over variants of fixed RT-063 through RT-095 repros.

- Deep nested ownership: two-level grouping, multi-tab command-created destinations, native close event-order variants, and focus/session churn inside nested windows.
- Opener chains: child/grandchild openers across relocation, undo/redo, native close, focus, and partial/reordered query evidence.
- Restore/native-close mixes: closed subtree restore through undo/history, native close orders, delete rejection after restore, and delayed restored-tab echoes after focus.
- Command side-effect rejection: focus and restore create operations whose browser side effects happen before adapter rejection, plus relocation rejection followed by another relocation.
- Multi-window query skew: missing one whole window while another is reordered, empty focused-window evidence, and stale event-local evidence followed by partial snapshots.
- Novel restart boundaries: opener/restore mixes, focus rejection before restart, multiple browser-created tabs with session churn, and runtime ID gaps.

## Post-Recovery Hunt Targets

Post-recovery discovery started from 139 regression traces and 167 discovery traces after the restore create rejection recovery fix. After triage and promotion, the corpus has 142 regression traces and 217 discovery traces. Add neutral `ph-*` traces and leave fixed RT-derived regression traces frozen.

- Command close rejection: outliner close of a tab, single-tab window, multi-tab window, or grouped subtree where the browser close completes before the adapter rejects.
- Restore/native-close mixes: restored tabs or windows followed by native close event-order variants, delayed restored-tab echoes, partial query, focus churn, and restart reconstruction.
- Opener chains: child/grandchild opener relocation combined with source deletion or close, undo/redo, stale opener evidence, and missing or reordered query results.
- Multi-window query skew: simultaneous missing/reordered source and destination windows, no-command browser-created tabs, and stale event-local evidence crossing two runtime windows.
- Focus/session churn: activation or focus side effects after rejected focus or close commands, followed by session-only refreshes.
- Restart reconstruction: close rejection or restore/native-close state across background restart, with runtime ID gaps and delayed stale evidence after ledger facts are reconstructed.

## Transaction Boundary Sweep

Transaction-boundary discovery started from 142 regression traces and 217 discovery traces after close recovery triage. After RT-104/RT-105 promotion, the corpus has 144 regression traces and 263 discovery traces. Add further `lh-*` traces by cloning, and avoid mutating fixed `rt-*`, `bh-*`, or `ph-*` repros.

- Target one rule: command side effects for close, delete, restore, relocation, and focus should all become explicit ledger facts before browser evidence can race them.
- Prefer current-resource captures after restore or history replay. Do not assume a restored tab keeps its old browser tab id.
- Avoid stale `lastOpenedWindow` after undo/redo when the runtime window may have disappeared; prefer `lastMovedTab`, current restored captures, or `firstRuntimeWindow`.
- Avoid assuming any runtime window is focused after destructive close/delete/history interleavings unless the trace explicitly focuses one.
- Initial sparse cells: transaction chains, multi-resource close plans, no-focused-window focus/session edges, partial snapshots after recovery, and restart/history reconstruction after recovered side effects.

## History Boundary Sweep

History-boundary discovery started from 144 regression traces and 263 discovery traces after the transaction-boundary fix. The first history-boundary sweep found `RT-106` through `RT-127`; after the fix pass those traces are regression coverage, leaving 166 regression traces and 303 discovery traces. Add further `hh-*` traces by cloning new neutral probes, and avoid mutating fixed `rt-*`, `bh-*`, `ph-*`, `lh-*`, or fixed `hh-*` repros.

- Target one rule: undo/redo may replay old outline structure, but must not rematerialize browser resources that are currently closed, deleted, tombstoned, or absent after restart.
- Prefer traces where a trackable history command happens before a later close/delete/restore/runtime lifecycle change.
- Cover normal close, rejecting close, native close, restore/delete rejection, stale event, partial query, session, and restart around closed or tombstoned resources.
- Keep `RT-104` through `RT-127` as regression baselines only; use fresh neutral `hh-*` clones for new variants.

## Five-Minute Mutation Block

A clean block is measured by wall-clock mutation effort, not by the runner's corpus cap and not by the UI's total turn duration. Start a timer for the block. If a new distinct bug appears, record it, reset the clean-streak count, and start a fresh block. If no new distinct bug appears, keep inspecting sparse coverage cells, editing or adding discovery traces, and rerunning the discovery profile until the block has consumed about five minutes.

Do not count a quick inspect/edit/run cycle as a full clean block just because the selected corpus ran once. The runner executes the current corpus once and may finish quickly; the five-minute budget belongs to the adversarial agent loop around the runner.

Do not count time spent waiting for trace execution as mutation effort. A five-minute block means about five minutes of active adversarial work: inspecting sparse coverage, reading relevant code, designing or cloning traces, editing the corpus, and deduping results. Runner wall-clock time is separate verification time, even when the runner takes longer than five minutes.

If the runner is slow, finish the corpus run so failures are fully recorded, then resume the mutation-effort timer afterward. Do not call a block clean merely because a long corpus run produced no new findings; perform the remaining active mutation work and rerun the selected discovery corpus.

Do not count a corpus run as clean if it stops at the runner safety boundary before completing the selected traces. Increase `RUNTIME_TRACE_HUNT_CORPUS_RUN_MS` or reduce the explicit trace selection when you need a complete sweep of a large corpus.

1. Read this guide, the current discovery trace definitions, and the relevant controller/model code.
2. Do not read fixed repro details in `RUNTIME_TRACE_BUGS.md` until after candidate mutations have been written and run.
3. Choose one or two sparse coverage cells.
4. Add or mutate `discovery` traces with neutral IDs, threat-model notes, and tags.
5. Run the discovery profile once. The runner records every distinct failure in that selected corpus.
6. After the run, use `RUNTIME_TRACE_BUGS.md` only to dedupe signatures and preserve evidence.
7. Optionally run the regression profile before and after a discovery block for safety; do not mutate regression traces during discovery.

Stop only after three full five-minute discovery mutation blocks fail to uncover a new distinct signature.
