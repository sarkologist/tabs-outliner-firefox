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

- Runtime events: `openTab`, `activateTab`, `updateTab`, `focusWindow`, `sessionChanged`, `manualRefresh`.
- Commands: `outlinerGroupTab`, `outlinerMoveTabToNewWindow`, `outlinerMoveTabCommandToNewWindow`, `outlinerMoveSubtreeToTopLevel`, `outlinerFocusTab`, `outlinerCloseTab`, `outlinerCloseWindow`, `outlinerUndo`, `outlinerRedo`.
- Failure-shape commands: `outlinerDeleteWindowRejectingClose`, `outlinerDeleteTabRejectingClose`, `outlinerDeleteNodeRejectingClose`, `outlinerRestoreDeleteWindowDelayedEvent`.
- Stale echoes: `staleLiveUpdatedEvent`, `staleLiveCreatedEvent`, `flushRuntimeEvents`.

`openTab` may include `openerTab` to model opener/reparenting behavior.

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

Pick sparse cells before adding another close variant:

| State shape | Command edge | Runtime skew | Refresh edge | Tags |
| --- | --- | --- | --- | --- |
| flat windows | move tab to command window | stale old-window created/update | manual refresh | `relocation`, `stale-event`, `manual-refresh` |
| grouped/nested windows | close parent or source window | window removed before tab removed | session refresh | `nested-window`, `native-close`, `session` |
| opener-linked tabs | move opener or opened tab | opener points across windows | manual refresh | `opener`, `reparenting` |
| closed/restored subtree | delete after restore | delayed restored-tab event | session refresh | `restore`, `delayed-event` |
| partial command failure | delete or close rejects | runtime resource already gone | stale snapshot | `delete-rejection`, `tombstone` |
| focus churn | focus/activate during command | stale active snapshot | manual refresh | `focus`, `activation` |
| history replay | undo/redo around live command | stale event from undone shape | manual refresh | `undo-redo`, `stale-event` |

## Five-Minute Mutation Block

A clean block is measured by wall-clock mutation effort, not by the runner's corpus cap and not by the UI's total turn duration. Start a timer for the block. If a new distinct bug appears, record it, reset the clean-streak count, and start a fresh block. If no new distinct bug appears, keep inspecting sparse coverage cells, editing or adding discovery traces, and rerunning the discovery profile until the block has consumed about five minutes.

Do not count a quick inspect/edit/run cycle as a full clean block just because the selected corpus ran once. The runner executes the current corpus once and may finish quickly; the five-minute budget belongs to the adversarial agent loop around the runner.

1. Read this guide, the current discovery trace definitions, and the relevant controller/model code.
2. Do not read fixed repro details in `RUNTIME_TRACE_BUGS.md` until after candidate mutations have been written and run.
3. Choose one or two sparse coverage cells.
4. Add or mutate `discovery` traces with neutral IDs, threat-model notes, and tags.
5. Run the discovery profile once. The runner records every distinct failure in that selected corpus.
6. After the run, use `RUNTIME_TRACE_BUGS.md` only to dedupe signatures and preserve evidence.
7. Optionally run the regression profile before and after a discovery block for safety; do not mutate regression traces during discovery.

Stop only after three full five-minute discovery mutation blocks fail to uncover a new distinct signature.
