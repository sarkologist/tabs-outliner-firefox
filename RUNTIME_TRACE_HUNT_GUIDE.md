# Runtime Trace Hunt Guide

This guide is the data reference for domain-level runtime discovery: corpus roles, DSL summary, invariants, threat model, coverage matrix, sparse targets, and historical sweep notes.

Use [RUNTIME_TRACE_HUNT_RUNBOOK.md](./RUNTIME_TRACE_HUNT_RUNBOOK.md) for the self-contained procedure to run a hunt. The runbook owns the stop rule, five-minute active mutation block definition, temperature ladder, subagent scout contract, runner commands, and fix-pass boundary.

Use this file before reading fixed repro histories. Treat `RUNTIME_TRACE_BUGS.md` as a post-run dedupe and evidence log, not as the source of new trace ideas.

## Corpus Roles

- `regression` traces preserve known RT/SS findings and run in ordinary `pnpm test`.
- `discovery` traces are neutral threat-model probes. Mutate these during the adversarial hunt.
- `known-finding` origins should not be used as discovery prompts.
- `threat-model` and `agent-generated` origins are the normal discovery inputs.

## Procedure Reference

Do not infer hunt procedure from older chat context or historical sections in this guide. Use [RUNTIME_TRACE_HUNT_RUNBOOK.md](./RUNTIME_TRACE_HUNT_RUNBOOK.md) for:

- subagent scout responsibilities;
- runner commands and corpus semantics;
- active five-minute mutation block rules;
- mutation temperature ladder;
- stop condition;
- fix-pass boundary and performance gate.

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

- Runtime events: `openTab`, `activateTab`, `updateTab`, `focusWindow`, `nativeSetWindowState`, `sessionChanged`, `manualRefresh`, `restartBackground`, `restartBackgroundAbrupt`.
- Commands: `outlinerGroupTab`, `outlinerMoveTabToNewWindow`, `outlinerMoveTabCommandToNewWindow`, `outlinerMoveSubtreeToTopLevel`, `outlinerFocusTab`, `outlinerCloseTab`, `outlinerCloseWindow`, `outlinerUndo`, `outlinerRedo`.
- Failure-shape commands: `outlinerDeleteWindowRejectingClose`, `outlinerDeleteTabRejectingClose`, `outlinerDeleteNodeRejectingClose`, `outlinerCloseNodeRejectingClose`, `outlinerMoveTabCommandToNewWindowRejectingCreate`, `outlinerFocusTabRejectingUpdate`, `outlinerRestoreNodeRejectingCreate`, `outlinerRestoreDeleteWindowDelayedEvent`.
- Crash-boundary commands: `outlinerGroupTabThenAbruptRestart`, `outlinerMoveTabCommandToNewWindowThenAbruptRestart`, `outlinerMoveSubtreeToTopLevelThenAbruptRestart`, `outlinerCloseNodeThenAbruptRestart`, `outlinerDeleteNodeThenAbruptRestart`, `outlinerRestoreNodeThenAbruptRestart`, `outlinerUndoThenAbruptRestart`, `outlinerRedoThenAbruptRestart`, and `injectCloseJournalThenAbruptRestart`.
- Query skews: `manualRefreshWithStaleQuery`, `manualRefreshWithMissingTabQuery`, `manualRefreshWithMissingWindowQuery`, `manualRefreshWithReorderedQuery`.
- Stale echoes: `staleLiveUpdatedEvent`, `staleLiveCreatedEvent`, `flushRuntimeEvents`.

`openTab` may include `openerTab` to model opener/reparenting behavior.
`nativeCloseWindow` may set `order` to `tabsRemovedThenWindowRemoved`, `windowRemovedThenTabsRemoved`, `windowRemovedOnly`, or `tabsRemovedOnly`.
`outlinerRestoreNodeRejectingCreate` may set `captureRestoredTabs` and `captureRestoredWindows`; these captures bind to current live runtime resources restored from the original closed outline node IDs, not historical tab/window IDs.
`nativeOpenWindow`, `nativeMoveTabToWindow`, and `nativeMoveTabToNewWindow` model browser-authored runtime changes without a Tabs Outliner command transaction or lifecycle journal.
`nativeSetWindowState({ window, state })` models browser-authored window state changes such as `"fullscreen"` and `"normal"`. Treat these as window-shape evidence only; they must not stand in for focus, session, close/delete, or lifecycle evidence.
`restartBackground` flushes pending saves, recreates the background controller against the same fake runtime/storage, calls `ensureState`, and keeps named stale captures intact so delayed browser evidence can arrive after restart.
`restartBackgroundAbrupt` drops listeners, clears pending fake runtime callbacks, and recreates the controller without flushing runtime events or pending saves. Use it only for crash-boundary traces where the durable lifecycle journal, not the ephemeral ledger, must recover confirmed browser side effects.

## Invariants

Every action is followed by the generated runtime invariants. The important classes are:

- live outline window IDs match live runtime window IDs;
- live outline tab IDs match live runtime tab IDs;
- live tab window ownership matches the runtime tab's current window;
- active flags agree with browser state;
- closed or deleted outline subtrees do not contain live runtime resources;
- stale event/query snapshots do not resurrect moved or removed runtime resources.

## Fix-Pass Performance Gate

Every correctness fix pass needs a **Perf Blast Radius** before findings are marked fixed or promoted to regression:

- Map changed trace tags to perf tags first: `close`, `native-close`, `journal`, `delete`, `restore`, `relocation`, `history`, `focus`, and `manual-refresh`.
- Run `pnpm perf:runtime-guard` after `pnpm build`; use `RUNTIME_PERF_GUARD_TAGS=journal,close` or `RUNTIME_PERF_GUARD_SCENARIOS=close-last-tab-removed-then-session` for targeted prechecks.
- Interpret guard counters by blast radius: `saves` means full outline/history persistence, `journalWrites` means tiny lifecycle durability hints, `stateBroadcasts` means tree/node/active state patches, and `statusBroadcasts` means small history-status messages.
- A finding is not fixed until correctness regression traces and the selected perf guard pass. If correctness requires moving a full save onto an interaction path, redesign it or explicitly record an accepted perf budget movement.
- Do not promote traces or update `RUNTIME_TRACE_BUGS.md` fixed statuses while the selected perf guard is red.
- Projection/sidebar fix passes use `pnpm perf:sidebar-projection-guard` instead of relying on ad hoc profile-loop inspection. The guard hard-fails startup hover/action/hydration regressions and sparse scroll-away row-window regressions, with one confirmation retry for browser timing noise.
- `scripts/analyze-profile-export.mjs` is optional forensic tooling for a fresh current-build `tabsOutlinerProfile` export. Historical exports are evidence for diagnosis, not acceptance gates for a current fix.

## Threat Model

Focus mutations on stale or contradictory evidence crossing command boundaries:

- a command moves, closes, restores, or deletes runtime resources while older browser events are still pending;
- `tabs.query` or session refresh returns a partial, stale, or reordered snapshot;
- window removal and tab removal events disagree about ownership;
- a command rejects after the runtime operation partially or fully happened;
- opener relationships move across windows or outlive their source window;
- undo/redo replays model history while runtime events from the old state still arrive.

## Coverage Matrix

Current coverage after Runtime Oracle Hunt Block 1 on 2026-05-31: 251 regression traces and 860 discovery traces, with open runtime findings RT-222 through RT-242. The oracle block added neutral `oc-b1-*` traces for browser-authored native open/move/close, stale refresh evidence, runtime side-effect assertions, and short closed-subtree persistence. The new `oc-*` traces passed explicit replay; the broader discovery corpus exposed existing no-journal/provenance and native-deleted resurrection failures under the newer truth-cache oracles, so those failing traces are frozen as findings until a later fix pass. The restart-stress expansion recorded RT-063 through RT-090 and was promoted to regression coverage. The breadth sweep added neutral `bh-*` discovery traces, recorded RT-091 through RT-095 around restore create rejection side effects, and those five traces are now promoted to regression coverage after the recovery fix. The post-recovery sweep added neutral `ph-*` traces and recorded RT-096 through RT-103; RT-096, RT-098, and RT-103 are promoted regression coverage, while the remaining RT-097/099/100/101/102 entries were harness artifacts corrected in discovery traces. The transaction-boundary sweep recorded RT-104 and RT-105 around history replay after recovered relocated closes; both are promoted after the history replay fix. The history-boundary sweep recorded RT-106 through RT-127 and promoted them after the lifecycle guard pass. The lifecycle journal crash sweep recorded RT-128 through RT-154 and promoted them after the durability fix. The browser-authored drift sweep recorded RT-155 through RT-170 and promoted them after the native move/history preservation fix. The runtime shape integrity sweep recorded RT-171 through RT-186 around active fallback, tab order, command-relocated move-back, and restored-resource metadata; all are promoted after the runtime shape authority fix. User-reported external browser-created window close finding UR-001 is regression coverage. The browser-created closed-state sweep recorded RT-187 and RT-190 around external closed record deletion across abrupt restart; both are promoted after runtime window scope routing and empty-plan delete journaling. Duplicate evidence RT-191 through RT-198 is preserved in discovery and passes the current smoke. The window scope routing sweep recorded RT-199 through RT-204 around last-tab `sessionChangedOnly` close evidence in saved/restored/reconstructed scopes; all six are promoted after the session-only missing-scope fix. The restored-scope browser-action sweep recorded RT-205 through RT-213 around stale event-local `created`/`updated` evidence overwriting current same-window reorder active/metadata shape; all nine are promoted after the shape-fresh runtime facts fix. The fullscreen/window-state sweep recorded RT-214 through RT-216 and promoted them after browser-created provenance reconstruction plus harness actionability hardening. The cross-axis escape sweep recorded RT-217 through RT-218 around history replay stale active shape after browser-authored move; both are promoted after the history replay runtime-shape overlay fix. The snapshot-confidence sweep added 48 neutral `qh-*` traces and found no new signatures. The bug-rich calibration plus sparse sweep added 32 neutral `ca-*`/`ra-*` traces and found no new signatures. The subagent sweep added 41 neutral traces, recorded RT-219, preserved RT-220/RT-221 as duplicate evidence, and promoted them after history journal recovery learned to remove superseded materialized window subtrees while preserving current runtime live tabs. The mixed-provenance sweep added 39 neutral `yh-*` traces and found no new signatures. The proper runbook follow-up added 27 neutral `yh-*` traces under the corrected five-minute active-block rule and found no new signatures. The subagent-assisted runbook hunt added 16 neutral `sa-*` traces and found no new signatures. The soak-complement hunt added 13 neutral `sk-*` traces across repeated command ownership, active/focus evidence, stale/partial snapshots, browser-authored drift, command rejection, history, journal, restored/browser-created provenance, and temporal heat; it found no new signatures, so these entries are sparse coverage movement, not bug-numbered findings or regression-backed coverage. Crash-boundary focused tests now cover durable recovery for close, delete, restore, relocation, history replay, native tab close, and native window close.

The matrix now follows the runtime reconciliation architecture rather than the older scenario-first axes. Use the older sweep sections below as evidence history; use this table to choose new sparse architecture joints.

| Architecture joint | Ownership/provenance axis | Evidence/freshness axis | Durability/history axis | Current coverage | Next target |
| --- | --- | --- | --- | --- | --- |
| Scope ownership routing | `saved`, `restored`, `browserCreated`, `commandCreated`, unknown-before-confirmed, reconstructed scopes | tab/window/focus/session events routed to current or last-known runtime window scope; stale old-generation echoes ignored | `restartBackground` and `restartBackgroundAbrupt` rebuild scopes from durable outline plus complete runtime snapshot | regression-covered after RT-187 through RT-204 and UR-001; discovery has broad `oh-*`, `wh-*`, and `sh-*` probes | combine provenance crossings with history replay and strict shape assertions, not more last-tab session-only clones |
| Shape freshness and dominance | same scoped tab/window may receive saved/restored/browser-created/command-created facts | field-masked tab evidence for active/order/metadata/window-state; complete snapshots dominate stale event-local payloads | restart reconstructs accepted shape facts from outline plus browser snapshot | regression-covered after RT-171 through RT-186, RT-205 through RT-216; `runtimeOrder` and `runtimeMetadata` assertions exist for opt-in traces | preserve current complete runtime shape during history replay; continue using assertions when browser shape is authoritative |
| Lifecycle durability | close, delete, restore, relocation, history replay, native tab/window close | runtime side effect may complete before command result, event delivery, save, or echo absorption | bounded lifecycle journal recovers confirmed side effects after abrupt restart; native close pending-save paths are covered | regression-covered after RT-106 through RT-154, UR-001, RT-187/190, and RT-199 through RT-204 | only add new crash cells when they introduce a new evidence source or provenance boundary |
| Command transaction ownership | TO-authored close/delete/restore/relocation/focus/history operations | command-owned echoes, adapter rejection after browser side effect, stale created/updated/removed events | transaction commits/rejects plus journal recovery keep browser side effects and outline state aligned | regression-covered after RT-091 through RT-105 and RT-128 through RT-154 | avoid one-off rejection variants; probe whether all command families share one recovery rule |
| Browser-authored drift | native open, native move, native close, reorder, opener, metadata, fullscreen/window state without TO command ownership | no command transaction, no lifecycle journal, no command echo guard; current browser evidence must drive convergence | restart/no-journal and abrupt restart reconstruct from durable outline plus runtime snapshot | regression-covered after RT-155 through RT-170, RT-171 through RT-186, UR-001, and RT-214 through RT-216 | favor cross-axis mixes: browser drift followed by TO history replay or command-created scope changes |
| History replay merge boundary | old outline deltas meet current saved/restored/browser-created/command-created live resources | stale delta fields must not overwrite current runtime `windowId`, active state, metadata, order, or existence unless the history operation intentionally deletes/restores them | undo/redo may cross restart, journal recovery, closed-state handoff, and browser-authored drift | regression-covered after RT-104 through RT-127 and RT-217 through RT-218; focused tests cover active/inactive browser moves, restart, redo, and native detach | widen only with genuinely new history axes, such as multi-window strict-shape assertions or restore/delete/history mixes |
| Snapshot confidence and refresh normalization | complete, partial, event-local, stale-suspect snapshots across all provenances | missing whole windows, missing tabs, reordered tabs, stale event-local copies, manual refresh | startup and manual refresh must not delete or resurrect resources without enough confidence | broad discovery/regression coverage across `dh-*`, `jh-*`, `nh-*`, `mh-*`, `wh-*`, and `xh-*` traces | add multi-window strict-shape assertions when snapshot confidence is the intended stress |
| Projection/UI hydration boundary | visible projected rows, loaded coverage, partial outline slices, remote query/target slices | sidebar action availability must match coverage; stale projection responses must not beat newer search/show-in-tree intent; patches should not trigger full repaint or inert controls | hydration and first paint are performance/UI concerns, not runtime reconciliation truth | covered by `SIDEBAR_PROJECTION_HUNT_GUIDE.md`, `tests/playwright/sidebar-projection-hunt.spec.ts`, and perf guardrails, not by runtime trace matrix | keep a separate projection matrix; only add runtime traces when a sidebar symptom reveals a background authority or persistence bug |

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

## Lifecycle Journal Crash Sweep

Lifecycle-journal discovery started from 166 regression traces and 303 discovery traces after the durability pass, expanded to 379 discovery traces, and recorded RT-128 through RT-154. After the fix pass, those traces are regression coverage, leaving 193 regression traces and 352 discovery traces. Add neutral `jh-*` traces only; avoid mutating fixed `rt-*`, `bh-*`, `ph-*`, `lh-*`, fixed `hh-*`, or fixed `jh-*` repros. Use `RUNTIME_TRACE_HUNT_BATCH_SIZE=50` for regression safety replays so the known corpus runs in coarse batches before falling back to one-trace isolation only on failure.

- Target one boundary: the browser may complete a close, delete, restore, relocation, or history-replay side effect, then the background may die before runtime events, outline saves, history saves, or ephemeral ledger facts survive.
- `restartBackgroundAbrupt` models lost listeners, pending event delivery, pending saves, and ephemeral ledger facts. It should be paired with a command action that writes the durable lifecycle journal before touching the fake browser runtime.
- The journal is a recovery hint, not durable ledger state. Startup should only apply it when complete runtime evidence confirms the side effect; otherwise it should clear or no-op.
- Initial cells: outliner close crash, delete crash, restore create crash, relocation crash, undo/redo crash, no-op unconfirmed journal, already-persisted state plus uncleared journal, stale event contradiction, and native browser action without a journal.
- If an abrupt trace fails because pending fake event work still arrived after restart, fix the harness before counting it as a finding. If the failure is an invariant mismatch after confirmed recovery, record it as a new runtime bug.
- The completed sweep stopped after three full active mutation blocks with no new distinct signatures. The fixed findings clustered into close-journal recovery loss, delete/native-tab tombstone stale-echo loss, and native window-close save-loss across abrupt restart.

## Browser-Authored Drift Sweep

Browser-authored drift discovery started from 193 regression traces and 352 discovery traces after the lifecycle-journal crash fix and expanded to 419 discovery traces. After the RT-155 through RT-170 fix pass, the failing `nh-*` traces are promoted regression coverage, leaving 209 regression traces and 403 discovery traces. Add future browser-authored drift probes as fresh neutral discovery traces; avoid mutating fixed `rt-*`, `bh-*`, `ph-*`, `lh-*`, fixed `hh-*`, fixed `jh-*`, or fixed `nh-*` repros.

- Target one boundary: reconciliation must converge from browser evidence when there is no command transaction, no lifecycle journal, and no command-owned stale echo guard.
- Prefer external runtime changes: native window/tab creation, native tab movement between windows, opener chains, focus/session churn, partial snapshots, and restart reconstruction.
- New `nativeOpenWindow` and `nativeMove*` actions are browser-authored. Pair them with refresh/session/focus/stale evidence when stressing delayed convergence.
- Initial sparse cells: external creation, native move, native move plus close, restart/no-journal, multi-window query skew, and history crossover controls.
- Perf guard is not part of discovery. It applies to the later fix/pass promotion step if this sweep records findings.

## Fullscreen Window-State Sweep

This sweep started from the `243` regression / `555` discovery baseline and added neutral `fh-*` discovery traces using `nativeSetWindowState`. The initial fullscreen batch brought the discovery corpus to `579` traces; mutation blocks expanded it to `600` traces and documented RT-214 through RT-216. After the fix pass, RT-214 through RT-216 are promoted and the baseline is `246` regression / `600` discovery traces. Fullscreen is browser-authored window shape, not focus, session, close/delete, restore, or lifecycle evidence.

- Target one boundary: fullscreen should update the scoped window shape fact without triggering tab/window close, session recovery, focus replay, or broad refresh on its own.
- Combine fullscreen with actual focus/session/lifecycle events only when those events are explicitly present in the trace.
- Sparse cells covered by the initial batch: saved/restored/browser-created/command-created fullscreen isolation, fullscreen before native close, fullscreen after restore, fullscreen across restart/abrupt restart, fullscreen plus stale `created`/`updated` echoes, fullscreen with missing/reordered queries, and undo/redo or restore/delete around fullscreen.
- Current focused tests assert a fullscreen bounds/state event records shape evidence without storage saves, broadcasts, tabs/window queries, session fetches, or outline active-state changes.
- Do not mutate fixed `rt-*`, `bh-*`, `ph-*`, `lh-*`, `hh-*`, `jh-*`, `nh-*`, `mh-*`, `oh-*`, `wh-*`, `sh-*`, or `ur-*` repros when adding fullscreen variants.

## Cross-Axis Escape Sweep

Cross-axis discovery started from the `246` regression / `600` discovery baseline after RT-214 through RT-216. The initial neutral `xh-*` batch brought the discovery corpus to `624` traces, mutation blocks expanded it to `640`, and the sweep recorded RT-217 through RT-218. After the fix pass, both are promoted and the baseline is `248` regression / `640` discovery traces. Add neutral `xh-*` discovery traces only; do not mutate fixed `rt-*`, `bh-*`, `ph-*`, `lh-*`, `hh-*`, `jh-*`, `nh-*`, `mh-*`, `oh-*`, `wh-*`, `sh-*`, `fh-*`, `xh-*`, or `ur-*` repros.

- Target one meta-boundary: avoid local variants of the last fullscreen/session-close basin by combining recent architectural axes that were previously tested mostly in isolation.
- Prefer browser-created or restored scopes plus later TO history replay; command-created destinations plus browser-authored move/reorder/metadata; native close or session-only disappearance after non-close window-shape changes; partial or reordered snapshots after scope generation changes; abrupt restart after browser-authored drift with no command journal; and opt-in `runtimeOrder` / `runtimeMetadata` assertions when browser shape is authoritative.
- Add `runtimeSideEffects` whenever a trace crosses the browser-authored/TO-authored boundary. Browser-authored actions should not call mutating browser APIs; TO commands should only call the browser API families expected for that command.
- Add `closedSubtreePersistence` for close/recent-close traces where the failure mode could be a saved-state or restart disappearance, not just an immediate in-memory shape bug.
- Initial sparse cells: provenance crossing, history crossover, snapshot confidence, restart/no-journal, strict shape assertions, and high-temperature mixes.
- Fullscreen/window-state evidence remains shape-only. Add explicit focus, session, close, restore, history, or refresh actions when those facts are part of the trace.
- Fixed cluster: TO history replay after browser-authored tab movement used to regress the moved tab's active state, including after restart reconstruction. Future discovery should avoid cloning only that active-history basin unless adding a materially different browser-shape axis.
- Perf guard is not part of discovery. It applies to the later fix/pass promotion step if this sweep records findings.

## Snapshot Confidence Shape Sweep

Snapshot-confidence discovery started from the `248` regression / `640` discovery baseline after RT-217 through RT-218. The initial neutral `qh-*` batch brought the discovery corpus to `664`, temperature-ladder mutations expanded it to `680`, and final escape mutations expanded it to `688`. Three clean active mutation blocks found no new distinct runtime signatures, so the current baseline is `248` regression / `688` discovery traces. Add future snapshot-confidence probes as neutral `qh-*` discovery traces only; do not mutate fixed `rt-*`, `bh-*`, `ph-*`, `lh-*`, `hh-*`, `jh-*`, `nh-*`, `mh-*`, `oh-*`, `wh-*`, `sh-*`, `fh-*`, `xh-*`, or `ur-*` repros.

- Target one boundary: partial, stale-suspect, event-local, and complete runtime evidence must not regress current browser shape or resurrect/erase live resources across multiple windows.
- Prefer multi-window query confidence stress: one window omitted while another is reordered or metadata-updated, event-local stale evidence followed by complete refresh, and restart/no-journal reconstruction followed by partial then complete snapshots.
- Use `assertions: ["runtimeOrder"]` only when the browser tab index order is authoritative for that trace. Use `runtimeMetadata` when current browser title/url/favicon should dominate stale event-local or partial query evidence.
- Use `runtimeSideEffects` as the default oracle for browser-authored native open/move/close, duplicate/create, stale event, refresh, and restart traces that previously only asserted final outline state.
- Use `closedSubtreePersistence` when expected closed nodes must survive a pending-save flush and background restart; this is required for small and large recent-close subtree hunts.
- Initial sparse cells: multi-window partial snapshots, event-local then complete refresh, reordered-query strict-shape checks, history plus query-confidence, restart/no-journal query recovery, and high-temperature mixes with fullscreen, opener, command-created, browser-created, and restored scopes.
- Runner wait time does not count as mutation effort. Use the mutation temperature ladder after clean active blocks; do not call a quick clean corpus replay a full clean block.
- Perf guard is not part of discovery. It applies to the later fix/pass promotion step if this sweep records findings.

## Bug-Rich Calibration Plus Real-User Sparse Sweep

This sweep started from the `248` regression / `688` discovery baseline after the clean snapshot-confidence sweep. It deliberately did two things in order: first a compact calibration pass over previous bug-rich basins, then sparse real-user-shaped probes that were not the center of the last matrix. The initial `ca-*`/`ra-*` batch brought the corpus to `704`, Rung 1 sparse mutations brought it to `712`, and final escape mutations brought it to `720`. Three clean active mutation blocks found no new distinct runtime signatures, so the current baseline is `248` regression / `720` discovery traces. Use neutral `ca-*` IDs for future calibration traces and `ra-*` IDs for future real-user-shaped traces; do not mutate fixed `rt-*`, `bh-*`, `ph-*`, `lh-*`, `hh-*`, `jh-*`, `nh-*`, `mh-*`, `oh-*`, `wh-*`, `sh-*`, `fh-*`, `xh-*`, `qh-*`, or `ur-*` repros.

- Calibration target: make sure the clean snapshot-confidence result did not come from escaping into an easier part of the state space. Recombine old hotspots: restored windows, browser-created closed records, command-created relocation destinations, close/delete rejection, lifecycle journal crash recovery, history replay, stale echoes, and partial query evidence.
- Sparse real-user target: external links/windows, restored-window browser actions, focus/session churn after current metadata, multiple independent browser-authored drifts before a TO history command, opener chains across restart, and command-created destinations with browser-created siblings.
- This is still runtime/model reconciliation discovery, not sidebar projection discovery. Projection bugs need a separate UI/hydration hunt.
- If calibration fails, stop and record every distinct signature before adding sparse variants. If calibration stays clean, keep going into sparse probes rather than replaying fixed bug IDs.
- Runner wait time does not count as mutation effort. After clean active blocks, raise the temperature by changing provenance, event order, restart boundary, or assertion type.
- Perf guard is not part of discovery. It applies to the later fix/pass promotion step if this sweep records findings.

## Subagent-Orchestrated Runtime Sweep

This sweep started from the `248` regression / `720` discovery baseline, ended discovery at `248` regression / `761` discovery traces, and after the RT-219 fix/promote pass now sits at `251` regression / `761` discovery traces. The main thread owns runner execution, dedupe, and log updates; subagents act as mutation scouts only. Use neutral `ua-*`/`ub-*`/`uc-*`/`ud-*` IDs for user-authored sparse probes from Scout A and `sb-*`/`sc-*`/`sd-*`/`se-*`/`sf-*` IDs for scope/shape architecture probes from Scout B. Do not mutate fixed `rt-*`, `bh-*`, `ph-*`, `lh-*`, `hh-*`, `jh-*`, `nh-*`, `mh-*`, `oh-*`, `wh-*`, `sh-*`, `fh-*`, `xh-*`, `qh-*`, `ca-*`, `ra-*`, `ua-*`, `ub-*`, `uc-*`, `ud-*`, `sb-*`, `sc-*`, `sd-*`, `se-*`, `sf-*`, or `ur-*` repros.

- Scout A target: restored-window and browser-authored user-shaped flows: opener parent/child divergence, external windows that continue after source close, dragged tabs between saved/restored/external windows, and focus in another browser-created scope while restored order changes.
- Scout B target: runtime scope/shape architecture: external-to-external transfers, browser-created tabs joining command-created windows, history replay over shared command/browser scopes, native drift followed by TO close journal, and fullscreen as window shape combined with opener/native-move axes.
- Subagent output is proposal-only. The main thread must adapt impossible fake-runtime selectors before counting failures, replay new traces explicitly, then run the selected corpus once and record every distinct failure.
- Runner wait time does not count as mutation effort. If this first subagent batch is clean, the next active block should ask scouts for a different axis rather than cloning only `ua-*` or `sb-*` variants.
- Fixed finding: RT-219, with duplicate evidence RT-220 and RT-221, was a history/journal live-resource preservation failure after dual browser-authored drift and `outlinerRedoThenAbruptRestart`. Future blocks should raise temperature away from local redo-journal-dual-drift clones.
- Perf guard is not part of discovery. It applies to the later fix/pass promotion step if this sweep records findings.

## Mixed-Provenance Window Cohabitation Sweep

This sweep started from the `251` regression / `761` discovery baseline after the RT-219 fix and ended at `251` regression / `800` discovery traces with no new findings. Use neutral `yh-*` discovery traces only for future mixed-provenance probes. The target is runtime windows where saved, restored, browser-created, command-created, or history-materialized tabs share a browser window, leave it, or outlive its original owner.

- Target scope ownership and shape facts when multiple provenance lines cohabit one runtime window; avoid cloning RT-219's redo-journal-dual-drift basin.
- Prefer mixed windows where one owner tab closes while a foreign tab remains, a foreign tab leaves while the owner remains, or whole-window close evidence arrives after ownership has become mixed.
- Combine cohabitation with current browser shape evidence: metadata, order, active tab, opener child, fullscreen/window state, stale echo, missing/reordered query, restart, or abrupt restart.
- Subagents are proposal-only scouts. The main thread owns trace edits, explicit replay, corpus runs, dedupe, and bug-log updates.
- Runner wait time does not count as mutation effort. Raise temperature after clean blocks by changing provenance mix, event source, event order, snapshot confidence, restart boundary, or assertion type.
- Completed sweep notes: initial `yh-*` cohabitation traces brought discovery to 785; Rung 1 architecture mutations brought it to 793; Rung 2 high-temperature history/partial/focus/fullscreen mixes brought it to 800. All three corpus runs were clean.
- Perf guard is not part of discovery. It applies to the later fix/pass promotion step if this sweep records findings.

## Preliminary Runbook Trace Pass

The first runbook follow-up on 2026-05-26 added three useful neutral traces, but it treated each add/replay/corpus-review cycle as a separate block. That does not satisfy the updated runbook's five-minute active mutation block rule. Keep these traces as ordinary discovery coverage; do not count the three entries below as a completed hunt stop condition.

- Block: 1
- Active effort: about five minutes of sparse-cell selection, trace design, edit, explicit replay, and corpus run review.
- Rung: 0
- Axes changed: command-created plus browser-created cohabitation, session-only native close, runtime-order assertion.
- Temporal boundaries crossed: serial command relocation, browser-authored merge, session-only disappearance, reordered refresh, stale survivor echo.
- New/changed trace ids: `yh-runbook-r0-command-owner-session-foreign-survivor`
- Explicit replay result: passed.
- Discovery runner result: `801` traces, `41` vitest processes, `0` failures, completed corpus.
- New signatures: none.
- Dedupe/result: clean block; raise to Rung 1.
- Block: 2
- Active effort: about five minutes of event-order mutation, trace edit, explicit replay, and corpus run review.
- Rung: 1
- Axes changed: event order/source, created event, command grouping, browser-authored move into command-created destination, strict shape assertions.
- Temporal boundaries crossed: unawaited created-tab evidence before command grouping, grouped destination reconciliation, reordered refresh, stale pre-command source echo.
- New/changed trace ids: `yh-runbook-r1-created-race-command-cohabit`
- Explicit replay result: passed.
- Discovery runner result: `802` traces, `41` vitest processes, `0` failures, completed corpus.
- New signatures: none.
- Dedupe/result: clean block; raise to Rung 2 with temporal heat check.
- Block: 3
- Active effort: about five minutes of temporal heat design, harness-precondition correction, explicit replay, and corpus run review.
- Rung: 2
- Axes changed: race, command rejection, session-only native close, stale event-local evidence, partial query, metadata assertion.
- Temporal boundaries crossed: pre-command created-tab evidence, command grouping, close rejection side effects, explicit session refresh, session-only native tab close, missing live-tab query, stale old-window created echo.
- New/changed trace ids: `yh-runbook-r2-race-close-reject-session-query`
- Explicit replay result: initial replay exposed a trace precondition issue by asking `manualRefreshWithMissingTabQuery` to omit a closed tab; corrected to omit live `tab:2`, then passed.
- Discovery runner result: `803` traces, `41` vitest processes, `0` failures, completed corpus.
- New signatures: none.
- Dedupe/result: third clean block; stop condition reached.

## Proper Runbook Hunt 2026-05-26

- Block: 1
- Active effort: timed active segments from `09:29:02` to `09:34:50` Europe/London, excluding the first discovery corpus wait; about five minutes of active guide/code inspection, inline scout design, edits, explicit replays, and result review.
- Rung: 0
- Axes changed: command-created/browser-created cohabitation, restored/browser-created owner handoff, command destination merge, opener grandchild relocation, fullscreen/window-state browser-created restart, strict order/metadata assertions.
- Temporal boundaries crossed: serial browser-authored moves after command/restored ownership changes, stale old-window echoes after current metadata/order, abrupt restart after browser-created fullscreen handoff.
- New/changed trace ids: `yh-proper-b1-command-foreign-leaves-owner-remains`, `yh-proper-b1-restored-owner-leaves-foreign-remains`, `yh-proper-b1-two-command-destinations-merge`, `yh-proper-b1-opener-grandchild-survives-parent-close`, `yh-proper-b1-window-state-foreign-close`, `yh-proper-b1-browser-fullscreen-saved-restart`
- Explicit replay result: first replay of three traces passed; second replay of two traces passed; final replay of the fullscreen/restart trace passed.
- Discovery runner result: first in-block corpus cycle `808` traces clean; final block corpus `809` traces, `41` vitest processes, `0` failures, completed corpus.
- New signatures: none.
- Dedupe/result: clean active block; raise to Rung 1.
- Block: 2
- Active effort: timed active segments from `09:36:42` to `09:45:25` Europe/London, excluding three discovery corpus waits; about five minutes of Rung 1 event-order design, edits, explicit replays, and post-run review.
- Rung: 1
- Axes changed: event source/order, update/focus/activation/window-state/created evidence, restored and browser-created sources, partial snapshots, strict shape assertions.
- Temporal boundaries crossed: unawaited runtime evidence before grouping, stale activation query after browser-authored move, missing-window/missing-tab snapshots after raced evidence, session-only close after created-tab race.
- New/changed trace ids: `yh-proper-b2-update-race-destination-omitted`, `yh-proper-b2-focus-race-restored-handoff`, `yh-proper-b2-stale-activation-race-cross-window`, `yh-proper-b2-restored-update-race-missing-sibling`, `yh-proper-b2-focus-race-browser-survivor-order`, `yh-proper-b2-window-state-race-external-partial`, `yh-proper-b2-restored-created-race-owner-session`, `yh-proper-b2-browser-update-race-missing-window`, `yh-proper-b2-browser-created-race-session-close`
- Explicit replay result: three replay batches passed.
- Discovery runner result: in-block corpus cycles at `812`, `814`, `816`, and `818` traces all completed clean with `0` failures.
- New signatures: none.
- Dedupe/result: clean active block; raise to Rung 2 and include temporal heat check before stopping.
- Block: 3
- Active effort: timed active segments from `09:47:31` to `09:56:07` Europe/London, excluding three discovery corpus waits; about five minutes of Rung 2 temporal/cross-axis design, harness-precondition correction, explicit replays, and post-run review.
- Rung: 2
- Axes changed: command rejection, restore rejection, close/delete journal recovery, history replay, abrupt restart, fullscreen/restored scope, browser-created scope, partial snapshots, session/query/refresh evidence.
- Temporal boundaries crossed: pre-command created/update evidence before grouping, command close/reject side effects, explicit session refresh, missing tab/window query evidence, stale old-window echoes after current shape, restart after session-only close.
- New/changed trace ids: `yh-proper-b3-temporal-race-close-reject-session`, `yh-proper-b3-history-command-browser-abrupt-partial`, `yh-proper-b3-restored-fullscreen-created-session-restart`, `yh-proper-b3-relocation-reject-session-partial`, `yh-proper-b3-restore-external-race-partial`, `yh-proper-b3-focus-reject-drift-session-query`, `yh-proper-b3-race-delete-journal-session-partial`, `yh-proper-b3-restore-reject-race-session-partial`, `yh-proper-b3-close-journal-browser-race-session`
- Explicit replay result: first replay found a harness precondition issue in `yh-proper-b3-history-command-browser-abrupt-partial` by omitting a window after its only tab moved away; corrected to omit live `tab:2`, then three replay batches passed.
- Discovery runner result: in-block corpus cycles at `822`, `825`, and `827` traces completed clean with `0` failures.
- New signatures: none.
- Dedupe/result: third clean active block; stop condition reached.

## Subagent-Assisted Runbook Hunt 2026-05-26

This hunt follows the updated runbook with real proposal-only subagents. Bug yield and coverage movement are recorded separately: clean traces add sparse coverage evidence only for the axes they actually sample.

- Block: 1
- Active effort: about five minutes of active subagent proposal review, sparse-cell selection, trace adaptation, two edit/replay/corpus cycles, and result review; corpus wait time excluded.
- Rung: 0
- Axes changed: browser-created same-window reorder, focus/session, opener source close, fullscreen source move-out, tabRemovedOnly event ordering, focused window-state omission, popup-chain split across windows.
- Temporal boundaries crossed: browser-authored move before focus/session evidence, partial missing-tab/missing-window snapshots before complete refresh, stale pre-reorder/pre-move created/updated evidence after current browser shape.
- New/changed trace ids: `sa-native-reorder-focus-session-partial`, `sa-external-opener-source-windowremovedonly`, `sa-fullscreen-native-move-out-partial`, `sa-tabsremovedonly-survivor-reorder`, `sa-focused-window-partial-state-only`, `sa-external-popup-chain-split-missing-source`
- Explicit replay result: first replay of five traces passed; second replay of the popup-chain trace passed.
- Discovery runner result: in-block corpus cycles at `832` and `833` traces completed clean with `0` failures.
- New signatures: none.
- Coverage movement: sampled-clean for pure browser-created runtime drift with focus/session plus partial snapshot evidence; sampled-clean for opener/source-close divergence and popup-chain split. Coverage remains sparse for history/restart/rejection combinations, so this is not promoted beyond sparse sampled coverage.
- Dedupe/result: clean active block; bug yield none; raise to Rung 1.
- Block: 2
- Active effort: about five minutes of active Rung 1 subagent proposal review, model/history trace design, two edit/replay/corpus cycles, and result review; corpus wait time excluded.
- Rung: 1
- Axes changed: history replay, restore materialization, delete/restore command rejection, unconfirmed close journal, session-only native close before undo, focused external popup after restore history.
- Temporal boundaries crossed: restored state across abrupt restart, undo/redo after command side effects, injected durable close intent without browser confirmation, session-only disappearance before stale history replay, partial restored/live-popup snapshots before stale echo.
- New/changed trace ids: `sa-undo-restored-delete-reject-stale-durable`, `sa-injected-close-journal-history-no-confirm`, `sa-native-close-before-undo-stale-history-save`, `sa-redo-restore-reject-current-metadata`, `sa-fast-focus-external-link-restore-history`
- Explicit replay result: first replay of three traces passed; second replay of two traces passed.
- Discovery runner result: in-block corpus cycles at `836` and `838` traces completed clean with `0` failures.
- New signatures: none.
- Coverage movement: sampled-clean to moderate for history/journal/restart interactions that were sparse after the previous mixed-provenance pass, especially unconfirmed journal plus undo and restore rejection plus redo. Still sparse for cross-axis temporal heat that combines command rejection, browser-authored drift, and partial/session evidence in one trace.
- Dedupe/result: clean active block; bug yield none; raise to Rung 2 with temporal heat check.
- Block: 3
- Active effort: about five minutes of active Rung 2 temporal-heat design, subagent proposal adaptation, two edit/replay/corpus cycles, and result review; corpus wait time excluded.
- Rung: 2
- Axes changed: restored opener detach, browser-created source split into saved/restored destinations, rejected relocation plus close journal/redo, startup-adjacent restored drift, pre-command race plus relocation rejection/session/partial query.
- Temporal boundaries crossed: restored materialization across abrupt restart, browser-authored detach before owner session-only close and restart, partial source omission before restored reorder, rejected relocation before close-journal recovery and redo, startup refresh after browser drift, pre-command metadata before grouping/rejection/session/stale echoes.
- New/changed trace ids: `sa-restored-opener-child-detach-owner-session`, `sa-restored-external-two-destination-skew`, `sa-redo-close-journal-after-rejected-relocation`, `sa-startup-reopen-restored-drift-before-refresh`, `sa-temporal-race-relocation-reject-session-query`
- Explicit replay result: first replay of three traces passed; second replay of two traces passed.
- Discovery runner result: in-block corpus cycles at `841` and `843` traces completed clean with `0` failures.
- New signatures: none.
- Coverage movement: moderate movement for combined restored/browser-created/native-move/history/restart temporal heat and sampled-clean movement for startup-adjacent restored drift. Coverage remains explicitly not complete: no new regression-backed bugs were found, and these new clean traces only cover their sampled subspaces.
- Dedupe/result: third clean active block; bug yield none; stop condition reached under the updated runbook.

## Runtime Soak-Complement Hunt 2026-05-27

This hunt started from the `251` regression / `843` discovery baseline after the generated-soak active-state fix. It treats random soak as a complementary signal: the hunt targets broad accidental cross-products without cloning seed `141616461`. Proposal-only scouts supplied ideas; the main thread owned trace edits, replay, corpus runs, dedupe, and stop-condition accounting. No new distinct runtime signatures were found.

- Block: 1
- Active effort: about five minutes of active DSL/code inspection, scout setup, trace design, one harness-precondition correction, explicit replay, and corpus review; corpus wait time excluded.
- Rung: 0
- Axes changed: repeated command relocation/top-level movement, command-created/browser-created cohabitation, active/focus evidence from source windows, stale old-window echoes, partial/reordered snapshots.
- Temporal boundaries crossed: command relocation before source activation, stale query evidence after active/focus changes, browser-created sibling joining a command destination, source close before delayed stale echoes.
- New/changed trace ids: `sk-b1-repeated-relocation-source-activation`, `sk-b1-group-race-source-focus-stale-query`, `sk-b1-command-destination-browser-sibling`, `sk-b1-repeated-top-level-source-close`
- Explicit replay result: first replay found a harness precondition issue in `sk-b1-command-destination-browser-sibling` by omitting a source window after moving out its only tab; corrected by leaving a browser-created survivor, then replay passed.
- Discovery runner result: first corpus cycle at `843` traces was clean but did not include new traces because the runner manifest was missing the new IDs; after updating the manifest, the corpus ran `847` traces clean with `0` failures.
- New signatures: none.
- Coverage movement: sampled-clean for broad soak-shaped command ownership races that combine repeated command-created ownership, source active/focus evidence, and stale/partial browser evidence. This is complementary to random soak and not promoted as covered/regression-backed.
- Dedupe/result: clean active block; bug yield none; raise to Rung 1.
- Block: 2
- Active effort: about five minutes of active scout proposal adaptation, event/source-axis selection, trace edit/replay/corpus review; corpus wait time excluded.
- Rung: 1
- Axes changed: browser-authored active drift, command-owner close rejection with a foreign survivor, focus rejection after native detach, opener child source close, relocation rejection plus focus/activation evidence.
- Temporal boundaries crossed: native move before stale active query, command-created owner close rejection before focus/reorder evidence, browser-authored detach before focus rejection, opener child escape before source `windowRemovedOnly`, relocation rejection before focus rejection/session/partial destination evidence.
- New/changed trace ids: `sk-b2-focus-native-move-stale-active-partial`, `sk-b2-command-owner-close-reject-foreign-survivor`, `sk-b2-focus-reject-after-native-detach-reordered`, `sk-b2-opener-source-windowremoved-survivor`, `sk-b2-reject-relocation-focus-side-effect`
- Explicit replay result: five-trace replay passed.
- Discovery runner result: `852` traces, `43` vitest processes, `0` failures, completed corpus.
- New signatures: none.
- Coverage movement: sampled-clean movement from pure command ownership into browser-authored drift, command rejection, focus/activation, opener, and snapshot-confidence axes. Still sparse for history/journal temporal heat.
- Dedupe/result: clean active block; bug yield none; raise to Rung 2 with temporal heat check.
- Block: 3
- Active effort: about five minutes of active temporal-heat design from history/durability scout proposals, trace edit/replay/corpus review; corpus wait time excluded.
- Rung: 2
- Axes changed: close journal in restored/browser-created cohabitation, undo crash recovery after restored/browser-created tab swaps, redo after restore rejection plus browser-created opener, injected journal after history and browser-authored drift.
- Temporal boundaries crossed: restored materialization across abrupt restart, browser-created foreign survivor before close-journal recovery, bidirectional browser/restored moves before undo abrupt restart, restore rejection before redo abrupt restart and partial opener evidence, unconfirmed journal after history replay and stale query evidence.
- New/changed trace ids: `sk-b3-close-journal-restored-foreign-survivor`, `sk-b3-undo-abrupt-restored-browser-swap`, `sk-b3-redo-restore-reject-browser-opener`, `sk-b3-injected-journal-history-browser-drift`
- Explicit replay result: four-trace replay passed.
- Discovery runner result: `856` traces, `43` vitest processes, `0` failures, completed corpus.
- New signatures: none.
- Coverage movement: sampled-clean movement for soak-complement temporal heat across history, journal, restart, restored/browser-created provenance, and stale/partial browser evidence. No new regression-backed coverage was created because no bug was found.
- Dedupe/result: third clean active block; stop condition reached.

## Runtime Oracle Hunt 2026-05-31

This hunt starts from the `251` regression / `856` discovery baseline after truth-cache and runtime side-effect oracles were added. It targets oracle gaps, not a behavior fix pass. New failing traces are frozen and recorded; fixes wait until after the hunt.

- Block: 1
- Active effort: about five minutes of active oracle-target selection, trace design, edits, explicit replay, corpus split review, and evidence-log updates; corpus wait time excluded.
- Rung: 0
- Axes changed: browser-authored native open/move/close, stale event-local and stale query evidence, runtime side-effect assertions, runtime order/metadata assertions, short closed-subtree persistence.
- Temporal boundaries crossed: browser-authored move before stale refresh, detach before source native close, same-window reorder before partial query, native close before save/restart persistence.
- New/changed trace ids: `oc-b1-native-open-move-stale-refresh`, `oc-b1-native-detach-close-source-stale`, `oc-b1-native-reorder-partial-stale-complete`, `oc-b1-native-close-persistence`
- Explicit replay result: four-trace replay passed.
- Discovery runner result: `860` traces, `303` vitest processes, `21` failures, `21` new findings, completed corpus.
- New signatures: RT-222 through RT-242, clustered around browser-created/command-restored provenance loss after no-journal restart and native-deleted restored-tab resurrection after session-only close.
- Coverage movement: oracle coverage moved from unsampled to sampled-clean for the four new `oc-b1-*` traces; the wider corpus is not clean because the new truth-cache oracle exposed open runtime bugs in older discovery traces.
- Dedupe/result: clean-block count reset to 0; continue the oracle hunt without fixing behavior.
- Block: 2
- Active effort: about five minutes of Rung 1 scope-mix design, trace edits, explicit replay, duplicate-failure corpus review, and evidence-log update; corpus wait time excluded.
- Rung: 1
- Axes changed: command-created/restored/browser-created cohabitation, partial and reordered snapshots, clean restart boundaries, runtime side-effect assertions, short mixed-window closed-subtree persistence.
- Temporal boundaries crossed: restored materialization before command relocation, browser-created tabs joining command/restored scopes before partial evidence, source native close before restart, mixed command destination close before persistence reload.
- New/changed trace ids: `oc-b2-three-scope-command-destination-restart`, `oc-b2-restored-browser-partial-reordered`, `oc-b2-command-browser-close-partial-restart`, `oc-b2-mixed-command-close-persistence`
- Explicit replay result: four-trace replay passed.
- Discovery runner result: `864` traces, `304` vitest processes, `21` duplicate failures, `0` new findings, completed corpus.
- New signatures: none.
- Coverage movement: sampled-clean for the new Rung 1 oracle scope-mix traces; open RT-222 through RT-242 still dominate full-corpus failure output.
- Dedupe/result: first clean active block after the Block 1 reset; raise to Rung 2 temporal heat.
- Block: 3
- Active effort: about five minutes of Rung 2 temporal-heat design, one harness-precondition correction, explicit replay, duplicate-failure corpus review, and evidence-log update; corpus wait time excluded.
- Rung: 2
- Axes changed: pre-command runtime evidence, command rejection, history replay, session/query evidence, stale echoes, browser-created drift, restored metadata, runtime side-effect assertions.
- Temporal boundaries crossed: raced update before grouping, relocation rejection before session/missing-destination evidence, browser drift before redo crash recovery, restore-create rejection before session/missing-window evidence, close rejection before partial browser-created survivor evidence.
- New/changed trace ids: `oc-b3-race-relocation-reject-session-stale`, `oc-b3-history-browser-drift-partial-stale`, `oc-b3-restore-reject-created-session-stale`, `oc-b3-close-reject-browser-partial-stale`
- Explicit replay result: initial replay found a harness precondition in `oc-b3-close-reject-browser-partial-stale` by omitting a tab closed by the rejected close side effect; corrected to omit the still-live browser-created survivor, then replay passed.
- Discovery runner result: `868` traces, `304` vitest processes, `21` duplicate failures, `0` new findings, completed corpus.
- New signatures: none.
- Coverage movement: sampled-clean for temporal oracle heat across command rejection/history/session/query/stale-echo combinations; open RT-222 through RT-242 remain the only discovery failures.
- Dedupe/result: second clean active block after the Block 1 reset; one more clean block is required for the stop condition.

## Runtime Shape Integrity Sweep

Runtime-shape discovery started from 209 regression traces and 403 discovery traces after the browser-authored drift fix and expanded to 461 discovery traces. It recorded RT-171 through RT-186 and stopped after three complete active mutation blocks found no new distinct signatures. After the shape fix and the later UR-001 external browser-created close regression promotion, coverage is 226 regression traces and 445 discovery traces. Add future shape probes as fresh neutral IDs and avoid mutating fixed `rt-*`, `bh-*`, `ph-*`, `lh-*`, fixed `hh-*`, fixed `jh-*`, fixed `nh-*`, fixed `mh-*`, or `ur-*` repros. This sweep adds opt-in trace assertions for order and metadata so failures are about browser shape, not only live ID convergence.

- Target one boundary: live runtime IDs now have broad coverage, so stress whether the outline preserves current browser shape: tab order, metadata, opener nesting, active/focus state, and multi-tab window structure.
- Sparse tags to prioritize: `metadata`, `partial-close`, `reparenting`, `paired-echo`, `race`, `updated-event`, `delayed-event`, `multi-tab`, and `nested-window`.
- Use `assertions: ["runtimeOrder"]` only when runtime tab order should match outline preorder for the selected shape. Avoid using it on opener traces where nested opener structure intentionally differs from flat browser tab order.
- Use `assertions: ["runtimeMetadata"]` on traces where current runtime title/url/favicon should be authoritative after browser update, refresh, restart, restore, or stale echo evidence.
- Findings clustered into active fallback after browser-authored reorder, runtime tab order after cross-window moves, command-relocated tabs moved back by the browser, and restored-resource metadata overwritten by stale echo evidence. The fix pass made runtime shape facts explicit in reconciliation: browser move/order evidence can force snapshot reconciliation, suspicious order/metadata snapshots are corroborated, command-relocated echo guards are cleared by later browser-authored moves, and transient restore echoes stay cheap.

## Browser-Created Closed-State Sweep

Browser-created closed-state discovery started from 226 regression traces and 445 discovery traces after UR-001 and expanded to 489 discovery traces. After the runtime window scope routing fix, RT-187 and RT-190 are regression coverage and the current corpus is 228 regression traces and 487 discovery traces. Add neutral `oh-*` discovery traces only; avoid mutating fixed `rt-*`, `bh-*`, `ph-*`, `lh-*`, fixed `hh-*`, fixed `jh-*`, fixed `nh-*`, fixed `mh-*`, `ur-*`, or fixed primary `oh-*` repros.

- Target one boundary: external browser-created live resources that become closed outline records should behave like durable outline records, not stale live runtime resources.
- Prefer restore, delete, undo/redo, restart, opener/nesting, and query-skew actions after external native close has already preserved the browser-created subtree as closed.
- Cover native close event shapes that create closed records without TO command ownership: session-only, tabs-only, window-only, window-then-tabs, and stale created/updated echoes.
- Findings clustered around TO delete of already-closed external records across abrupt restart: window records resurrected (`RT-187`, with duplicate evidence `RT-191` through `RT-196` and `RT-198`) and tab records resurrected (`RT-190`, with duplicate evidence `RT-197`). The fix added an ephemeral runtime window scope index and journals deletes of closed scoped/tombstoned runtime rows even when there is no live close plan. `RT-188` and `RT-189` are marked as harness artifacts from an overbroad temporary session-only expectation.
- Keep profile-export analysis out of hunt/fix acceptance unless a fresh current-build profile is captured for a specific manual performance question.

## Window Scope Routing Sweep

Window-scope discovery started from 228 regression traces and 487 discovery traces after the runtime window scope routing fix, expanded to 528 discovery traces, and recorded RT-199 through RT-204. After the session-only missing-scope fix, the promoted corpus is 234 regression traces and 522 discovery traces. Add new neutral `wh-*` discovery traces only; avoid mutating fixed `rt-*`, `bh-*`, `ph-*`, `lh-*`, fixed `hh-*`, fixed `jh-*`, fixed `nh-*`, fixed `mh-*`, fixed `oh-*`, fixed `wh-*`, or `ur-*` repros.

- Target one boundary: the browser event stream is global, but every observation should route through the current runtime-window scope owner before reconciliation.
- Stress provenance transitions: `saved`, `restored`, `browserCreated`, `commandCreated`, unknown-before-confirmed, and removed/tombstoned scopes.
- Prefer current captures and `firstRuntimeWindow` over historical ids after restore/restart/close; stale old captures should be used only as explicit stale evidence.
- Initial sparse cells: restored-window shape, browser-created closed/live handoff, command-created destination ownership, unknown/saved scope evidence, restart reconstruction, opener/nested/race routing.
- Fixed cluster: last-tab `sessionChangedOnly` evidence now corroborates missing live window scopes instead of leaving stale live outline tabs after scope provenance is saved/restored/reconstructed. Future discovery should avoid cloning this exact root cause unless checking a genuinely different browser event shape.
- Perf guard is not part of discovery. It applies to the later fix/pass promotion step if this sweep records findings.

## Restored-Scope Browser Action Sweep

Restored-scope browser-action discovery started from 234 regression traces and 522 discovery traces after the session-only missing-scope fix, expanded to 564 discovery traces, and recorded RT-205 through RT-213. After the shape-fresh runtime facts fix, the promoted corpus is 243 regression traces and 555 discovery traces. Add future neutral `sh-*` discovery traces only; avoid mutating fixed `rt-*`, `bh-*`, `ph-*`, `lh-*`, fixed `hh-*`, fixed `jh-*`, fixed `nh-*`, fixed `mh-*`, fixed `oh-*`, fixed `wh-*`, fixed `sh-*`, or `ur-*` repros.

- Target one boundary: browser-authored opens, closes, moves, metadata updates, and focus/session churn inside already-scoped live windows should keep routing to the current owner, especially after restore or restart.
- Prefer non-last-tab closes, child tab opens, opener chains, same-window reorder, cross-window moves, and stale old-generation echoes over the fixed last-tab `sessionChangedOnly` shape.
- Use `assertions: ["runtimeMetadata"]` when current browser title/url/favicon is authoritative; add `runtimeOrder` only when the trace intentionally expects flat outline preorder to match browser tab index order.
- Initial sparse cells: restored-window internal browser edits, browser-created live-scope edits, command-created destination edits, saved-window controls, and history/restart crossovers after live browser edits.
- Fixed cluster: stale event-local `created`/`updated` tab evidence captured before a same-window browser reorder can no longer overwrite newer active/metadata shape after the event is routed to the correct saved, command-created, or browser-created scope. The fix adds field-masked tab evidence and shape-fact dominance so ownership and freshness stay separate. Do not clone this exact failure unless checking a materially different shape.
- Fullscreen note: the domain trace DSL now supports `nativeSetWindowState`; keep old `sh-*` traces frozen and add fresh neutral fullscreen probes in the next sweep.
- Perf guard is not part of discovery. It applies to the later fix/pass promotion step if this sweep records findings.

## Hunt Procedure

Procedure intentionally lives in [RUNTIME_TRACE_HUNT_RUNBOOK.md](./RUNTIME_TRACE_HUNT_RUNBOOK.md). Keep this guide as data: DSL, invariants, coverage, sparse targets, and historical sweep notes.
