# Tabs Outliner Performance Notes

## Context

This file started as `DELETE_PERFORMANCE_NOTES.md` while investigating slow single-node deletes. It now records the broader performance tuning work for deletes, restore, focus/tab switching, close, runtime refreshes, persistence, diagnostics, and sidebar rendering.

The original delete investigation found several costs that turned out to generalize across the extension.

Original likely bottlenecks:

- `deleteNode()` clones the entire `OutlineState` before deleting a small subtree.
- `deleteNode()` calls `removeEmptyWindowNodes()`, which scans every node looking for empty windows.
- Removing a child from a large sibling array uses `indexOf`/`splice`.
- The background saves and broadcasts the full state after mutations.
- The sidebar can render once from the command response and again from the `stateUpdated` broadcast.
- Each sidebar render rebuilds the full visible-tree projection, even though DOM rows are virtualized.

Rough generated-state measurements from local investigation:

- 100k-node leaf delete model work: about 84-100ms.
- Sidebar visible-tree projection once: about 68ms.
- Full-state serialization proxy (`JSON.stringify`) once: about 79ms; twice: about 155ms.

These numbers are only directional; browser extension structured cloning, storage, and UI render timing may differ.

## Current Status

As of 2026-05-17, the broadly applicable lessons from the accepted performance work have been applied across the command/runtime paths we tuned:

- Mutating commands acknowledge with `commandAck` and rely on broadcasts, avoiding duplicate sidebar renders from command responses.
- Small visible changes use compact `nodeStateUpdated`, `treeStructureUpdated`, or `activeStateUpdated` patches instead of full `stateUpdated` transport.
- Runtime refreshes use material/semantic diffs, because `reconcileWithWindows()` clones the tree and identity diffs would make every node look changed.
- Unchanged commands, no-op runtime updates, stale Firefox events, and command-owned echoes are filtered or absorbed before they save/broadcast unchanged state.
- Full storage persistence is deferred and coalesced off the visible interaction path; profiles report perceived time separately from eventual save flush time.
- Sidebar diagnostics are advisory and coalesced so they do not multiply immediate background work after every patch.
- Compact patch paths preserve important full-render side effects, especially active-tab auto-scroll.
- Real extension traces are available through `tabsOutlinerProfile` and should be preferred when synthetic profiles do not match manual QA.

Known follow-up, intentionally not tackled before longer naturalistic QA:

- Fresh trace `dist/snapshot3.log` showed no full `stateUpdated` broadcasts and no sidebar hotspot, but it did show long trains of queued `tabs.onUpdated` runtime refreshes. If usability still feels sluggish, the next likely target is in-flight runtime-refresh coalescing and/or command priority so stale refresh work cannot sit in front of focus/close/restore commands.

## General Lessons

- Profile before accepting performance changes. Record the scenario, tree size, command/tool, before/after numbers, and whether the measurement is synthetic or in-browser.
- Separate perceived latency from eventual durability. Visible broadcasts should not wait for full `storage.local.set` when a deferred, coalesced save is acceptable.
- Avoid whole-state transport unless the change surface is genuinely whole-tree sized. Prefer compact patches and keep full `getState`/diagnostic paths available for compatibility.
- Preserve node identity for unchanged model nodes. It makes patches smaller and keeps future cache/projection reuse possible.
- Treat no-op and echo events as first-class performance work. A fast operation can still feel slow if stale browser events trigger later snapshots, saves, or broadcasts.
- Coalesce advisory/background work such as diagnostics and persistence. Advisory work should not contend with user-visible mutations.
- When replacing full renders with patches, audit side effects that used to live inside `render()`: scrolling, counters, empty states, active flags, rename/drop cleanup, and diagnostics scheduling.
- Synthetic Node profiles are useful for repeatability, but browser-extension structured cloning, sidebar contexts, storage, and Firefox event ordering can dominate. Use in-browser traces before larger architectural changes.

## Agent Instructions

Update this file as you investigate and implement performance improvements.

- Keep the `Progress Log` section current. Add a new dated entry for each meaningful experiment, design decision, implementation step, or surprising finding.
- Record commands, benchmark shapes, tree sizes, and before/after numbers when available.
- Preserve prior findings unless they are clearly wrong; if correcting one, add a note explaining why.
- Prefer red-green TDD for behavior changes, following `AGENTS.md`.
- For interleaving-heavy controller/sidebar changes, add deterministic tests that cover duplicate events, stale broadcasts, and repeated renders.
- Do not treat a passing microbenchmark as sufficient; confirm the manual QA path or a realistic browser/sidebar simulation when possible.

## Historical Candidate Fixes

1. Make small deletes avoid full-state cloning.
   - Consider a targeted copy-on-write delete path that clones only `rootIds`, removed ancestors/sibling arrays, the parent node, and affected nodes.
   - Preserve object identity for unchanged nodes so sidebar caches can eventually reuse work.

2. Replace global empty-window scanning after local deletes.
   - For delete, only the deleted node's parent chain can become empty.
   - Implement a targeted empty-window cleanup that walks upward from the affected parent rather than scanning `Object.values(state.nodes)`.

3. Reduce duplicate sidebar renders.
   - Today mutating commands can return a full state and also trigger a `stateUpdated` broadcast.
   - Investigate returning an acknowledgement for mutating commands, or suppressing the matching broadcast in the initiating sidebar.
   - Make sure other extension views still receive updates.

4. Avoid rebuilding the entire visible projection for tiny changes.
   - A near-term option: skip full projection rebuild when the changed state only removes nodes outside the visible range and no search is active.
   - A stronger option: maintain an incremental projection/index keyed by state identity and changed node IDs.
   - Preserve counts (`nodeCount`, `closedCount`, `matchCount`) accurately.

5. Measure real persistence/message cost.
   - Instrument `saveState`, `runtime.sendMessage`, sidebar `render`, and `buildVisibleTreeProjection`.
   - Measure command-response structured clone separately from broadcast structured clone if possible.

## Acceptance Targets

Use these as starting targets, not hard promises:

- Deleting one leaf from a 50k-node closed tree should feel near-instant in manual QA.
- The model-layer delete for a leaf should avoid O(total nodes) work where practical.
- The initiating sidebar should not do two full projection rebuilds for one delete.
- Existing lifecycle behavior must remain intact for browser-native close, outliner close, delete-owned removals, restore, and stale events.

## Progress Log

### 2026-05-16: Initial Diagnosis

- Batched runtime tab deletion was merged, but it did not improve deleting one node in a large tree.
- Investigation found the single-node path is dominated by full-state clone/scan, full-state persistence/broadcast, and full sidebar projection rebuilds.
- Added this file so future agents have context and a place to record progress.

### 2026-05-16: Command Ack Contract for Mutating Sidebar Commands

- Selected Candidate Fix 3 as the highest-yield perceived-latency improvement: stop returning a full `OutlineState` to the initiating sidebar for mutating commands that already broadcast `stateUpdated`.
- Added a `commandAck` response shape (`{ type: "commandAck", stateChanged: boolean }`) for background commands. `getState` remains the full-state response path; diagnostics remain unchanged.
- Updated the sidebar to ignore `commandAck` responses for rendering and rely on the single `stateUpdated` broadcast, avoiding the previous command-response render plus broadcast render pair.
- Added controller coverage for `deleteNode` returning an ack while broadcasting exactly one state update, and for `focusNode` returning an unchanged ack without saving or broadcasting.
- Verification: `pnpm test -- src/background/controller.test.ts`, `pnpm test`, and `pnpm run build` passed.

### 2026-05-16: Targeted Model Delete Copying

- Implemented the next model-layer delete item: `deleteNode()` now shallow-copies the `nodes` record, clones only modified parent/window nodes, deletes the requested subtree, and reuses unchanged node objects.
- Paired Candidate Fix 1 with the delete-specific part of Candidate Fix 2: after a local delete, empty-window cleanup now starts from the deleted node's parent and walks upward instead of scanning every node.
- Added a 50k-node leaf-delete regression test that asserts unchanged tab object identity is preserved, the parent window is copied, and the original state's sibling array is not mutated.
- Note: because `OutlineState.nodes` is a plain `Record`, removing keys immutably still requires a shallow key-table copy. This avoids the previous deep clone of every node and child array, but it is not a fully persistent map.
- Verification: `pnpm test -- src/model/outline.test.ts`, `pnpm test`, and `pnpm run build` passed.

### 2026-05-16: First Explicit Mutable Command Path

- Added an explicit `changed` bit to background `CommandResult` so the controller no longer relies on `result.state !== current` to decide whether to save and broadcast.
- Converted the `toggleCollapsed` command path to mutate the controller-owned `OutlineState` in place. This removes the previous whole-`nodes` record copy for a one-node collapsed-state toggle.
- Added command/controller tests proving `toggleCollapsed` reuses the same state object, still reports `changed: true`, and still persists/broadcasts through the controller.
- This is intentionally a narrow mutable-core step. Most model exports remain pure/immutable for now, and the broader tree-changing operations still need their own conversion or draft/store abstraction.
- Verification: `pnpm test -- src/background/commands.test.ts src/background/controller.test.ts`, `pnpm test`, and `pnpm run build` passed.

### 2026-05-16: Repeatable Tab-Open Profiling Harness

- Added `pnpm profile:tab-open` to profile background runtime-event refresh behavior against built `dist/` code. Run `pnpm run build` before profiling.
- Baseline command: `pnpm profile:tab-open -- --tabs 50000 --updates 5 --scenario open-tab-storm`.
  - Result before refresh coalescing: 2,431ms total, 7 saves, 7 broadcasts, 467ms JSON stringify proxy, 179 MB stringified, 50,002 nodes.
- Baseline command: `pnpm profile:tab-open -- --tabs 50000 --scenario noop-update`.
  - Result before refresh coalescing/no-op filtering: 369ms total, 1 save, 1 broadcast, 64ms JSON stringify proxy, 26 MB stringified, 50,001 nodes.

### 2026-05-16: Coalesced Runtime Refresh Bursts

- Added a zero-delay runtime-event refresh coalescer for `tabs.onCreated`, `tabs.onUpdated`, `tabs.onActivated`, and `windows.onFocusChanged`. Manual `refresh` commands still run immediately.
- Added deterministic controller coverage for a new-tab event burst (`created` + two `updated` events + `activated`) collapsing to one save/broadcast while preserving the final tab URL/title/active state.
- Before/after using `pnpm profile:tab-open -- --tabs 50000 --updates 5 --scenario open-tab-storm` after `pnpm run build`:
  - Before: 2,431ms total, 7 saves, 7 broadcasts, 467ms JSON stringify proxy, 179 MB stringified.
  - After: 480ms total, 1 save, 1 broadcast, 75ms JSON stringify proxy, 26 MB stringified.
- The no-op update scenario remains expensive after this step: `pnpm profile:tab-open -- --tabs 50000 --scenario noop-update` still reports 405ms total, 1 save, 1 broadcast, 76ms JSON stringify proxy, 26 MB stringified.
- Verification: `pnpm test -- src/background/controller.test.ts`, `pnpm test`, `pnpm run build`, and both profile commands above passed.

### 2026-05-16: Skipped Irrelevant Tab Update Events

- Added an `onUpdated` filter so empty/status-only tab updates do not enter the runtime refresh queue. Relevant fields are currently `active`, `favIconUrl`, `title`, and `url`.
- Added controller coverage proving empty and status-only updates do not save or broadcast.
- Before/after using `pnpm profile:tab-open -- --tabs 50000 --scenario noop-update` after `pnpm run build`:
  - Before: 405ms total, 1 save, 1 broadcast, 76ms JSON stringify proxy, 26 MB stringified.
  - After: 0ms total, 0 saves, 0 broadcasts, 0ms JSON stringify proxy, 0 MB stringified.
- Re-ran `pnpm profile:tab-open -- --tabs 50000 --updates 5 --scenario open-tab-storm`; it remains one meaningful save/broadcast: 480ms total, 1 save, 1 broadcast, 80ms JSON stringify proxy, 26 MB stringified.
- Verification: `pnpm test -- src/background/controller.test.ts`, `pnpm test`, `pnpm run build`, and both profile commands above passed.

### 2026-05-16: Repeatable Restore Profiling Harness

- Added `pnpm profile:restore` to profile a user-facing restore path against built `dist/` code. Run `pnpm run build` before profiling.
- The initial scenario was `single-closed-tab`: sidebar restore-scope analysis, background `restoreNode`, full-state save/broadcast JSON proxy, and one sidebar visible-tree projection.
- Baseline command: `pnpm profile:restore -- --tabs 50000 --target last`.
  - Result before restore model optimization: 186ms total measured, 0ms sidebar scope, 60ms command, 46ms save stringify, 48ms broadcast stringify, 32ms projection, 30 MB stringified.
- Cross-check command: `pnpm profile:restore -- --tabs 50000 --target first`.
  - Result before restore model optimization: 192ms total measured, 0ms sidebar scope, 63ms command, 46ms save stringify, 48ms broadcast stringify, 35ms projection, 30 MB stringified.

### 2026-05-16: Targeted Restore Node Copying

- Optimized `restoreNodes()` for small restores: it now shallow-copies the `nodes` record and clones only restored node records instead of deep-cloning every node and child array.
- Added a 50k-node regression test proving a single restored tab gets a new node object while unrelated tabs and the parent window preserve object identity.
- Before/after using `pnpm profile:restore -- --tabs 50000 --target last` after `pnpm run build`:
  - Before: 186ms total measured, 60ms command, 46ms save stringify, 48ms broadcast stringify, 32ms projection.
  - After: 144ms total measured, 13ms command, 57ms save stringify, 39ms broadcast stringify, 34ms projection.
- Cross-check using `pnpm profile:restore -- --tabs 50000 --target first`:
  - Before: 192ms total measured, 63ms command, 46ms save stringify, 48ms broadcast stringify, 35ms projection.
  - After: 150ms total measured, 16ms command, 53ms save stringify, 41ms broadcast stringify, 40ms projection.
- Remaining measured restore cost is dominated by full-state save/broadcast serialization and full visible-tree projection rebuild.
- Verification: `pnpm test -- src/model/outline.test.ts src/background/commands.test.ts src/background/controller.test.ts`, `pnpm test`, `pnpm run build`, and both restore profile commands above passed.

### 2026-05-16: Restore Event Echo Absorption

- Extended `pnpm profile:restore` with `--scenario controller-event-echo` to measure the restore command plus the browser `tabs.onCreated` echo that follows command-created restored tabs.
- Baseline after targeted restore node copying: `pnpm profile:restore -- --scenario controller-event-echo --tabs 50000 --target last` measured 617ms total, 159ms command, 459ms event echo, 2 saves, 2 broadcasts, 76ms projection, 59 MB stringified.
- Implemented one-shot absorption for restored tab created-event echoes when the restore command already incorporated the same runtime tab. Restored tab nodes now also copy the runtime `active` flag, which lets the controller safely recognize the created event as redundant.
- After: the same controller-event-echo profile measured 187ms total, 172ms command, 15ms event echo, 1 save, 1 broadcast, 25ms projection, 30 MB stringified.
- Cross-check command profile after the change: `pnpm profile:restore -- --scenario single-closed-tab --tabs 50000 --target last` measured 146ms total with one save/broadcast path.

### 2026-05-16: Focus Command Activation Echo Absorption

- Added `pnpm profile:focus` to measure sidebar tab switching: `focusNode` command time plus the browser focus/activation event echo and sidebar projection.
- Baseline using `pnpm profile:focus -- --tabs 50000 --target last` after `pnpm run build`: 538ms total, 4ms command, 534ms event echo, 1 save, 1 broadcast, 29ms projection, 26 MB stringified.
- Cross-check baseline using `pnpm profile:focus -- --tabs 50000 --target middle`: 546ms total, 4ms command, 543ms event echo, 1 save, 1 broadcast, 26ms projection, 26 MB stringified.
- Implemented a command-owned focus fast path: the controller now absorbs the focus command's `tabs.onActivated`, `tabs.onUpdated(active)`, and `windows.onFocusChanged` echoes, updates active tab/window flags directly when safe, and leaves native activation events on the existing full-snapshot path for stale Firefox cleanup.
- After using `pnpm profile:focus -- --tabs 50000 --target last`: 152ms total, 13ms command, 139ms event echo, 1 save, 1 broadcast, 36ms projection, 26 MB stringified.
- Cross-check after using `pnpm profile:focus -- --tabs 50000 --target middle`: 147ms total, 14ms command, 134ms event echo, 1 save, 1 broadcast, 33ms projection, 26 MB stringified.

### 2026-05-16: Close Command Session Echo Absorption

- Added `pnpm profile:close` to measure sidebar close-button behavior: `closeNode` command time plus `tabs.onRemoved` and `sessions.onChanged` echoes, with both observed Firefox event orders.
- Baseline using `pnpm profile:close -- --tabs 50000 --target last --order tabRemovedThenSessionChanged`: 209ms total, 2ms command, 207ms event echo, 1 save, 1 broadcast, 29ms projection, 26 MB stringified, and a redundant session snapshot.
- Baseline using `pnpm profile:close -- --tabs 50000 --target last --order sessionChangedThenTabRemoved`: 322ms total, 2ms command, 320ms event echo, 2 saves, 2 broadcasts, 53ms projection, 51 MB stringified.
- Implemented a command-owned close fast path: when `tabRemoved` handles an outliner close, the following session echo is skipped; when sessions arrive first, the later no-op `tabRemoved` pass no longer saves or broadcasts unchanged state.
- After using `pnpm profile:close -- --tabs 50000 --target last --order tabRemovedThenSessionChanged`: 190ms total, 3ms command, 187ms event echo, 1 save, 1 broadcast, 34ms projection, 26 MB stringified, 0ms tab-query snapshot work.
- After using `pnpm profile:close -- --tabs 50000 --target last --order sessionChangedThenTabRemoved`: 246ms total, 3ms command, 243ms event echo, 1 save, 1 broadcast, 29ms projection, 26 MB stringified.

### 2026-05-16: Lightweight Focus Active Updates

- Extended `pnpm profile:focus` with `--scenario successive-command-event-echo --count N` to measure repeated sidebar focus clicks.
- Baseline using `pnpm profile:focus -- --scenario successive-command-event-echo --tabs 50000 --count 10`: 1374ms total, 137ms average, 10 saves, 10 full broadcasts, 213ms projection, 255 MB stringified.
- Implemented a lightweight `activeStateUpdated` broadcast for command-owned focus activation/window-focus echoes. The background updates in-memory active flags but skips storage writes and full `stateUpdated` transport for volatile active-only changes.
- Updated the sidebar to apply active flag patches to `currentState`, refresh active-window flags in the existing projection only when a window active flag changes, and schedule a virtual-row rerender instead of rebuilding the full visible-tree projection.
- After using `pnpm profile:focus -- --scenario successive-command-event-echo --tabs 50000 --count 10`: 414ms total, 41ms average, 0 saves, 0 full-state broadcasts, 0ms projection, 0 MB stringified.
- Single-click cross-check using `pnpm profile:focus -- --tabs 50000 --target last`: 42ms total, 0 saves, 0 full-state broadcasts, 0ms projection, 0 MB stringified.

### 2026-05-16: Lightweight Delete Tree Patches

- Added `pnpm profile:delete` to measure sidebar delete-button behavior, including command time, ignored remove-event echo, save serialization, broadcast serialization, and sidebar projection.
- Baseline using `pnpm profile:delete -- --tabs 50000 --target last`: 132ms total, 38ms save stringify, 38ms full broadcast stringify, 34ms projection, 26 MB stringified.
- Baseline using `pnpm profile:delete -- --tabs 50000 --target middle`: 129ms total, 38ms save stringify, 37ms full broadcast stringify, 31ms projection, 26 MB stringified.
- Baseline using `pnpm profile:delete -- --tabs 50000 --target last --count 10`: 1060ms total, 106ms average, 10 saves, 10 full broadcasts, 204ms projection, 256 MB stringified.
- Implemented a lightweight `treeStructureUpdated` broadcast for `deleteNode`: the background sends deleted node ids, updated parent/root data, and deleted closed count to the sidebar before persisting the full outline state.
- Updated the sidebar to apply delete patches to `currentState`, filter deleted rows from the current visible projection, reindex rows, refresh changed parent row metadata, and schedule a virtual-row rerender instead of rebuilding the full projection.
- After using `pnpm profile:delete -- --tabs 50000 --target last`: 108ms total, first patch broadcast at 52ms, 49ms save stringify, 1ms patch broadcast stringify, 7ms tree patch, 0ms projection, 13 MB stringified.
- Cross-check after using `pnpm profile:delete -- --tabs 50000 --target middle`: 111ms total, first patch broadcast at 54ms, 45ms save stringify, 1ms patch broadcast stringify, 11ms tree patch, 0ms projection, 13 MB stringified.
- Repeated-delete after using `pnpm profile:delete -- --tabs 50000 --target last --count 10`: 884ms total, 88ms average, first patch broadcast at 49ms, 10 saves, 10 patch broadcasts, 61ms tree patch, 0ms projection, 134 MB stringified.
- Remaining measured total is dominated by full-state storage persistence after the sidebar patch is already sent.

### 2026-05-16: Lightweight Restore Node Patches

- Manual QA showed the same perceived-latency shape on restore as delete: the browser tab opens promptly, then the sidebar tree visibly catches up later.
- Baseline using `pnpm profile:restore -- --scenario controller-event-echo --tabs 50000 --target last`: 193ms total, 179ms command, 14ms event echo, 53ms save stringify, 54ms full broadcast stringify, 25ms projection, 30 MB stringified.
- Implemented a lightweight `nodeStateUpdated` broadcast for `restoreNode`: the background sends changed node records and a closed-count delta to the sidebar before persisting the full outline state.
- Updated the sidebar to apply restore patches to `currentState`, adjust the existing projection's closed count and row metadata, and schedule a virtual-row rerender instead of rebuilding the full visible-tree projection. Search projections still rebuild from state for correctness.
- After using `pnpm profile:restore -- --scenario controller-event-echo --tabs 50000 --target last`: 145ms total, first patch broadcast at 73ms, 57ms save stringify, 0ms patch broadcast stringify, 2ms node patch, 0ms projection, 15 MB stringified.
- Cross-check using `pnpm profile:restore -- --scenario single-closed-tab --tabs 50000 --target last`: 82ms total, 17ms command, 63ms save stringify, 0ms patch broadcast stringify, 2ms node patch, 0ms projection, 15 MB stringified.
- Remaining measured total is dominated by full-state storage persistence after the sidebar patch is already sent.

### 2026-05-16: Lightweight Close Node Patches

- Re-profiled close after the delete/restore patch work. Baseline still used one full `stateUpdated` broadcast and full sidebar projection:
  - `pnpm profile:close -- --tabs 50000 --target last --order tabRemovedThenSessionChanged`: 204ms total, 50ms save stringify, 40ms full broadcast stringify, 39ms projection, 26 MB stringified.
  - `pnpm profile:close -- --tabs 50000 --target last --order sessionChangedThenTabRemoved`: 255ms total, 36ms save stringify, 39ms full broadcast stringify, 31ms projection, 26 MB stringified.
- Implemented lightweight `nodeStateUpdated` close patches for close operations that only change node state. Structural closes, such as closing a tab whose children must be promoted, fall back to full `stateUpdated`.
- Optimized `closeTab()` and `closeWindow()` copying so a leaf tab close clones only the closed node, and a window close clones only the closed subtree. This keeps the patch detector on the fast identity path.
- After using `pnpm profile:close -- --tabs 50000 --target last --order tabRemovedThenSessionChanged`: 97ms total, first patch broadcast at 50ms, 45ms save stringify, 0ms patch broadcast stringify, 2ms node patch, 0ms projection, 13 MB stringified.
- After using `pnpm profile:close -- --tabs 50000 --target last --order sessionChangedThenTabRemoved`: 156ms total, first patch broadcast at 94ms, 36ms save stringify, 0ms patch broadcast stringify, 2ms node patch, 0ms projection, 13 MB stringified.

### 2026-05-16: Targeted Restore Patch Detection

- Manual QA still showed delayed restore tree updates after lightweight restore patches. Re-profiled `pnpm profile:restore -- --scenario controller-event-echo --tabs 50000 --target last`: 148ms total, first patch broadcast at 70ms, 52ms save stringify, 0ms projection.
- Found two whole-tree scans before the restore patch: event-echo restored-tab detection and generic node-patch detection both walked the full outline.
- Restore now builds its patch from the command's restore-plan candidate node IDs, including any planned window destination. The same candidate set is used to arm created-tab echo absorption.
- After using `pnpm profile:restore -- --scenario controller-event-echo --tabs 50000 --target last`: 110ms total, first patch broadcast at 13ms, 52ms save stringify, 0ms patch broadcast stringify, 2ms node patch, 0ms projection, 15 MB stringified.
- Cross-check using `pnpm profile:restore -- --scenario single-closed-tab --tabs 50000 --target last`: 69ms total, 21ms command, 0ms node patch build, 46ms save stringify, 2ms node patch.

### 2026-05-16: Restore Transient Echo Absorption

- Manual QA on a ~28k-node tree still reported >1s restore tree updates, which did not match the earlier synthetic profile.
- Added `--echo transient-separated` to `pnpm profile:restore` to model a more Firefox-like restore: a transient `tabs.onCreated` echo arrives with placeholder title/url, then a later no-op final `tabs.onUpdated` echo arrives after the command patch.
- Baseline using `pnpm profile:restore -- --scenario controller-event-echo --tabs 28000 --target last --echo transient-separated`: 447ms total, 3 saves, 3 broadcasts, 43ms full broadcast stringify, 27ms projection, 41 MB stringified.
- Fixed restored-tab echo absorption so command-owned restored tab create events are consumed by tab id/window id even when title/url are transient. Also filter runtime tab events that would not change the current live node, preventing later no-op final updates from forcing full reconciliation and `stateUpdated`.
- After using `pnpm profile:restore -- --scenario controller-event-echo --tabs 28000 --target last --echo transient-separated`: 64ms total, first patch broadcast at 9ms, 1 save, 1 patch broadcast, 0ms full broadcast stringify, 0ms projection, 8 MB stringified.
- Cross-check using `pnpm profile:restore -- --scenario controller-event-echo --tabs 50000 --target last --echo transient-separated`: 135ms total, first patch broadcast at 16ms, 1 save, 1 patch broadcast, 0ms projection, 15 MB stringified.

### 2026-05-16: General Runtime No-op Echo Coverage

- Generalized the restore lesson into explicit coverage for any `tabs.onUpdated` event whose metadata looks outline-relevant but already matches the current live node.
- Added `pnpm profile:tab-open -- --tabs 50000 --scenario metadata-noop-update` to keep this path measurable outside restore-specific profiles.
- Result after `pnpm run build`: 10ms total, 0 saves, 0 broadcasts, 0ms stringify, 0 MB stringified, 50,001 nodes.
- Current echo coverage: focus activation/window-focus echoes use active-state patches or no-op acks, close/delete remove-session echoes are command-owned, restore created-tab echoes are command-owned, and generic no-op tab metadata echoes are filtered before full reconciliation.

### 2026-05-16: Generalized Command Patch Pass

- Re-read the accumulated performance notes and applied the reusable rules to the remaining command paths:
  - preserve node identity for unchanged model nodes so command patches stay small;
  - send compact sidebar patches before full storage persistence when the changed surface is smaller than the tree;
  - treat unchanged commands and refreshes as no-ops instead of saving/broadcasting timestamp-only churn;
  - keep full-state broadcasts for genuinely whole-tree changes where a compact patch would be as large as the state.
- Added `pnpm profile:command` with 50k-node scenarios for `rename-window`, `toggle-window`, `move-leaf`, `flatten-window`, `import-small`, and `refresh-noop`.
- Targeted model-copying now covers `renameGroup`, ordinary `moveNode`, `flattenSubtreeOneLevel`, and `appendPortableTree`; empty imports now return the original state.
- Controller/sidebar patch routing now covers:
  - `renameGroup` and `toggleCollapsed` as `nodeStateUpdated`;
  - smaller structural `moveNode`, `moveNodeToNewWindow`, `flattenSubtree`, and `importTree` changes as `treeStructureUpdated`;
  - unchanged manual refresh snapshots as no-save/no-broadcast acks.
- Baselines using `pnpm profile:command -- --tabs 50000` before this pass:
  - `rename-window`: 165ms total, first broadcast at 94ms, 39ms full broadcast stringify, 32ms projection, 26 MB stringified.
  - `toggle-window`: 119ms total, first broadcast at 49ms, 44ms full broadcast stringify, 26ms projection, 26 MB stringified.
  - `move-leaf`: 240ms total, first broadcast at 169ms, 38ms full broadcast stringify, 32ms projection, 26 MB stringified.
  - `refresh-noop`: 521ms total, first broadcast at 450ms, 1 save, 1 full broadcast, 30ms projection, 26 MB stringified.
  - `flatten-window`: 176ms total, first broadcast at 103ms, 39ms full broadcast stringify, 34ms projection, 26 MB stringified.
- After using `pnpm profile:command -- --tabs 50000` after `pnpm run build`:
  - `rename-window`: 68ms total, first patch at 18ms, 1ms patch stringify, 0ms projection, 13 MB stringified.
  - `toggle-window`: 48ms total, first patch at 0ms, 1ms patch stringify, 0ms projection after collapsing the root, 13 MB stringified.
  - `move-leaf`: 221ms total, first patch at 139ms, 1ms patch stringify, 38ms projection rebuild, 13 MB stringified.
  - `import-small`: 138ms total, first patch at 66ms, 0ms patch stringify, 32ms projection rebuild, 13 MB stringified.
  - `refresh-noop`: 123ms total, 0 saves, 0 broadcasts, 0 MB stringified.
  - `flatten-window`: 195ms total, still full-state; this 50k shape changes nearly every visible row, so the compact patch would not be smaller than the state.
- Regression cross-checks after this pass:
  - `pnpm profile:delete -- --tabs 50000 --target last`: 113ms total, first patch at 55ms, 0ms projection.
  - `pnpm profile:restore -- --scenario controller-event-echo --tabs 50000 --target last --echo transient-separated`: 119ms total, first patch at 13ms, 0ms projection.
  - `pnpm profile:focus -- --tabs 50000 --target last`: 46ms total, 0 saves, 0 full-state broadcasts.
  - `pnpm profile:close -- --tabs 50000 --target last --order tabRemovedThenSessionChanged`: 103ms total, first patch at 55ms, 0ms projection.

### 2026-05-16: Active-Tab Highlight Scroll Diagnosis

- Investigated whether the highlight/auto-scroll-to-active-tab feature could explain lingering restore lag.
- Diagnosis: the optimized restore patch path does not call full `render()` or `scrollToObservedActiveTab()`, so active-scroll is unlikely to be the main restore-patch delay. It did still contain duplicate work on full renders: build the projection, render virtual rows, scan the whole tree again to find the active tab, linearly find the row, then render virtual rows again after scrolling.
- Baseline 50k-node full-render helper measurement after `pnpm run build`: projection 30ms, active-tab scan 9ms, row lookup 1ms. Browser DOM cost for the extra virtual render is not captured by this Node-only measurement.
- Folded active tab node/row tracking into `buildVisibleTreeProjection()` and changed sidebar full render to scroll before rendering rows. This removes the extra whole-tree active scan, row lookup, and immediate second synchronous virtual render.
- After helper measurement: projection 25ms, active observation 0ms, active row index available directly.
- Restore cross-checks after the change:
  - `pnpm profile:restore -- --scenario controller-event-echo --tabs 28000 --target last --echo transient-separated`: 56ms total, first patch at 8ms, 0ms projection.
  - `pnpm profile:restore -- --scenario controller-event-echo --tabs 50000 --target last --echo transient-separated`: 95ms total, first patch at 12ms, 0ms projection.

### 2026-05-16: Coalesced Sidebar Diagnostics Refreshes

- Investigated the next manual-QA symptom: the tree can keep doing background work after visible patch updates, especially across successive operations.
- Found that every full `stateUpdated`, `nodeStateUpdated`, and `treeStructureUpdated` sidebar message immediately called `getDiagnostics`. Diagnostics are advisory, but the request can contend with later operations because the background waits for queued mutations, queries runtime windows/tabs, and scans the outline.
- Added `pnpm profile:diagnostics` to keep this cost explicit before accepting the change. It compares the old immediate shape with the new coalesced shape against built `dist/` code.
- Added a small diagnostics scheduler with deterministic tests: burst requests collapse to one delayed load, and requests made while a diagnostics load is in flight schedule one follow-up rather than many overlapping loads.
- Updated the sidebar to schedule diagnostics after state/patch updates and after diagnostics notices expire, instead of calling `loadDiagnostics()` immediately on the update hot path.
- Profile results after `pnpm run build`:
  - `pnpm profile:diagnostics -- --tabs 28000 --requests 10 --mode immediate`: 10 diagnostics loads, 97ms total, 96ms diagnostics compute.
  - `pnpm profile:diagnostics -- --tabs 28000 --requests 10 --mode coalesced`: 1 diagnostics load, 12ms total, 12ms diagnostics compute.
  - `pnpm profile:diagnostics -- --tabs 50000 --requests 10 --mode immediate`: 10 diagnostics loads, 236ms total, 236ms diagnostics compute.
  - `pnpm profile:diagnostics -- --tabs 50000 --requests 10 --mode coalesced`: 1 diagnostics load, 22ms total, 22ms diagnostics compute.
- Restore cross-checks still use the fast visible patch path:
  - `pnpm profile:restore -- --scenario controller-event-echo --tabs 28000 --target last --echo transient-separated`: 59ms total, first patch at 8ms, 0ms projection.
  - `pnpm profile:restore -- --scenario controller-event-echo --tabs 50000 --target last --echo transient-separated`: 124ms total, first patch at 15ms, 0ms projection.

### 2026-05-16: Representative In-Browser Trace Harness

- Manual QA no longer shows one obvious hotspot, but the overall extension still feels sluggish. Before attempting an architectural rewrite, added opt-in tracing in the real extension contexts so we can capture actual sidebar/background timing instead of relying only on Node profiles.
- Added a bounded shared trace utility with tests. It records marks, sync durations, async durations, and summary rows while staying disabled by default.
- Added background trace coverage for runtime messages, command execution, mutation queue wait/run, runtime window snapshots, diagnostics, patch building, storage saves, broadcasts, and relevant browser events.
- Added sidebar trace coverage for command sends/responses, incoming runtime messages, full renders, projection builds/cache hits, active/node/tree patches, virtual row rendering, requestAnimationFrame delay, restore-scope analysis, diagnostics, and click actions.
- Manual QA usage from the sidebar console:
  - `await tabsOutlinerProfile.enable()`
  - perform the sluggish operation sequence
  - `await tabsOutlinerProfile.summary()` for grouped durations
  - `await tabsOutlinerProfile.snapshot()` for ordered sidebar/background trace entries
  - `await tabsOutlinerProfile.clear()` before a new run
  - `await tabsOutlinerProfile.disable()` when done
- This does not yet provide new numbers by itself; it is the more representative measurement surface needed before choosing an architectural direction.
- Verification: `pnpm test -- src/perf/trace.test.ts src/background/controller.test.ts` and `pnpm run build` passed.

### 2026-05-17: Deferred Full-State Persistence and Diagnostics Coalescing

- Analyzed manual QA traces saved as `dist/summary.log` and `dist/snapshot.log`.
- Main finding: sidebar work was no longer the bottleneck. In the trace, `sidebar.render` maxed at 19ms, `sidebar.projection.build` at 17ms, `sidebar.virtualRows` at 12ms, and patch application at 14ms or less.
- Background persistence dominated the sluggish feel: `background.state.save` ran 20 times at 823ms average / 866ms max, and `stateUpdated` broadcasts often took 600-900ms. These awaited operations kept later mutations and diagnostics stuck behind the queue.
- Diagnostics were also amplified by multiple sidebar contexts: bursts of roughly seven `getDiagnostics` messages arrived together, each doing its own background diagnostics request.
- Changed state-changing paths so visible broadcasts still happen immediately, but full `storage.local.set` persistence is scheduled through a coalesced background save. A new `flushPendingSaves()` controller method lets tests/profiles explicitly wait for eventual persistence.
- Full-state fallback broadcasts now happen before the deferred storage save, so full-state paths no longer wait for storage before updating sidebars.
- Added background diagnostics request coalescing so concurrent `getDiagnostics` requests share one runtime-window query and diagnostics scan.
- Updated profile harnesses to report perceived operation time separately from eventual `saveFlushMs`.
- Profile results after `pnpm run build`:
  - `pnpm profile:restore -- --scenario controller-event-echo --tabs 50000 --target last --echo transient-separated`: 60ms perceived, first patch at 13ms, deferred save flush 48ms.
  - `pnpm profile:close -- --tabs 50000 --target last --order tabRemovedThenSessionChanged`: 46ms perceived, first patch at 44ms, deferred save flush 36ms.
  - `pnpm profile:delete -- --tabs 50000 --target last --count 10`: 449ms perceived for 10 deletes, 45ms average, one coalesced deferred save flush of 34ms.
  - `pnpm profile:command -- --tabs 50000 --scenario move-leaf`: 156ms perceived, deferred save flush 36ms.
  - `pnpm profile:tab-open -- --tabs 50000 --updates 5 --scenario open-tab-storm`: 429ms perceived, deferred save flush 28ms.
- Verification: `pnpm test`, `pnpm run build`, and the profile commands above passed.

### 2026-05-17: Runtime Refreshes Prefer Compact Patches

- Analyzed follow-up manual traces saved as `dist/summary2.log` and `dist/snapshot2.log`.
- Main finding: the sidebar was still not the dominant cost (`sidebar.render` max 56ms, projection max 53ms), while full background `stateUpdated` broadcasts were still expensive (`background.runtime.broadcast:stateUpdated` count 14, total 17,916ms, max 1,783ms). Mutation queue waits were mostly behind `refreshFromRuntime` and `sessions.onChanged`.
- Generalized the patch routing lesson to runtime reconciliation:
  - command-owned model changes still use cheap identity-based diffs when possible;
  - runtime refreshes use material/semantic diffs because `reconcileWithWindows()` clones the whole tree;
  - small runtime title/url/active changes now broadcast `nodeStateUpdated`;
  - small runtime structural changes, including new-tab refreshes and structural close fallback, now broadcast `treeStructureUpdated`;
  - full `stateUpdated` remains the fallback when the compact patch would be whole-tree-sized or unsafe.
- Added controller coverage for runtime metadata refreshes producing `nodeStateUpdated`, new-tab bursts producing `treeStructureUpdated`, and structural close fallback avoiding full state.
- Profile results after `pnpm run build`:
  - `pnpm profile:tab-open -- --tabs 50000 --updates 5 --scenario open-tab-storm`: 520ms perceived, 1 broadcast, 1 deferred save, 39ms stringify, 13 MB stringified. This halves the full-state transport/save JSON volume from the previous 26 MB shape, though runtime reconciliation still dominates elapsed time in the Node profile.
  - `pnpm profile:restore -- --scenario controller-event-echo --tabs 50000 --target last --echo transient-separated`: 68ms perceived, first patch at 20ms, deferred save flush 56ms.
  - `pnpm profile:close -- --tabs 50000 --target last --order tabRemovedThenSessionChanged`: 51ms perceived, first patch at 49ms, deferred save flush 40ms.
  - `pnpm profile:command -- --tabs 50000 --scenario move-leaf`: 144ms perceived, first patch at 108ms, deferred save flush 41ms.
  - `pnpm profile:delete -- --tabs 50000 --target last --count 10`: 390ms perceived for 10 deletes, 39ms average, one coalesced deferred save flush of 40ms.
- Verification: `pnpm test`, `pnpm run build`, and the profile commands above passed.

### 2026-05-17: Active-Tab Scroll After Compact Patches

- Manual QA found a regression after replacing more full renders with compact patches: the sidebar no longer reliably scrolled to the active tab.
- Cause: full `render()` still observed and scrolled the active row, but `activeStateUpdated`, fast `nodeStateUpdated`, and fast `treeStructureUpdated` patch paths only updated the projection and scheduled virtual rows. They skipped the active-scroll side effect that full renders used to provide.
- Moved the active-row scroll calculation into the shared active-scroll helper and call it from compact patch paths after refreshing the active target, before the virtual row render is scheduled.
- Regression coverage: `src/sidebar/active-scroll.test.ts` now asserts that a newly observed active projection row scrolls into view once and does not retrigger for the same active node.
- Profile check after `pnpm run build`: `pnpm profile:focus -- --tabs 50000 --target last` reports 27ms perceived, 0ms active patch work, 0 saves, 0 MB stringified.
- Verification: `pnpm test`, `pnpm run build`, and the focus profile above passed.

### 2026-05-17: Active-Search Delete Burst Patches

- Analyzed manual QA traces saved as `dist/delete-nodes.summary.log` and `dist/delete-nodes.snapshot.log`.
- Main finding: the delete sequence was search-active. Each successful delete used a compact `treeStructureUpdated` patch, but the sidebar treated all search-active structural patches as full renders, rebuilding the search projection on every delete. Background saves also started during the burst: 15 `background.state.save` entries averaged about 830ms.
- Added `pnpm profile:delete -- --shape one-child-pairs --query needle` so a 50k-tab run creates 25k parent/child pairs and deletes parent nodes whose only child matches the active search.
- Added an incremental delete projection helper for search-active patches. It removes deleted rows, prunes now-empty path-only search ancestors, adjusts row indexes/subtree bounds from removed row positions, and keeps match/count/active-row metadata current without rebuilding the full projection.
- Changed deferred persistence to a trailing quiet debounce: saves run after 1000ms of no state changes, with a 5000ms max wait during continuous activity. Sidebar diagnostics now use the same trailing behavior with a 750ms delay.
- Profile results after `pnpm run build`:
  - `pnpm profile:delete -- --shape one-child-pairs --tabs 50000 --query needle --target last --count 20`: 795ms perceived for 20 deletes, 40ms average, first patch at 30ms, `projectionMs` 0, one deferred save flush of 34ms.
  - `pnpm profile:delete -- --tabs 50000 --target last --count 10`: 344ms perceived for 10 deletes, 34ms average, `projectionMs` 0, one deferred save flush of 30ms.
- Verification: `pnpm test`, `pnpm run build`, and the profile commands above passed.

### 2026-05-18: Drag/Drop 50k-Tab Profiling and Reorder Fast Paths

- Added Playwright browser profiling coverage for 50k-tab drag/drop in `tests/playwright/sidebar-drag-drop-performance.spec.ts`.
- Initial Playwright finding: dragover preview was not the bottleneck. The 50k preview dispatch averaged about 2.4-2.7ms with p95 about 3.6-3.8ms.
- The actual same-window leaf drop was slow: initial Playwright drop-to-visible-update timing was 71.5ms. The first traced reorder patch attempt removed the full projection rebuild but still spent 22.4ms in `sidebar.patch.treeStructure`.
- Background fix: live `moveNode` now first syncs only the moved live-tab segment instead of asking Firefox to move the whole live window preorder. A 50k leaf move now sends one tab id to `moveTabs`, not 50k tab ids.
- Sidebar fix: same-parent reorder `treeStructureUpdated` patches now splice the existing visible row segment and visible id segment in place. This keeps the full `sidebar.projection.build` path out of the common same-window drag/drop reorder.
- Profile results after `pnpm run build`:
  - Playwright dragover: avg 2.8ms, p95 4.5ms, max 6.1ms.
  - Playwright same-window leaf drop: 53-56ms elapsed, 7.7-7.8ms mocked command, 2.6-2.7ms `sidebar.patch.treeStructure`, 9.7-11.6ms `sidebar.virtualRows`, and no `sidebar.projection.build`.
  - `pnpm profile:command -- --tabs 50000 --scenario move-leaf`: perceived time was noisy but first patch broadcast improved from 84ms before this pass to 46ms after. This Node harness still models sidebar `treeStructureUpdated` by rebuilding the projection, so its `projectionMs` does not reflect the new browser-side reorder fast path.
- Verification: `pnpm test -- src/background/commands.test.ts`, `pnpm run build`, `pnpm exec playwright test tests/playwright/sidebar-drag-drop-performance.spec.ts --reporter=list`, and the `profile:command` run above passed.

### 2026-05-18: Undo/Redo History on Structural Commands

- Added persisted undo/redo history for structural commands, with compact per-command deltas rather than full state snapshots.
- Profiled the common same-window leaf move because it is a structural command on the hot drag/drop path.
- Baseline from a temporary `main` worktree after `pnpm run build`: `pnpm profile:command -- --tabs 50000 --scenario move-leaf` measured 77ms perceived, 115ms with save flush, first broadcast at 44ms, 38ms save stringify, 32ms projection, 1 broadcast, and 13 MB stringified.
- After optimizing history recording to use identity diffs and a candidate-node fast path for `moveNode`: the same command measured 69ms perceived, 104ms with save flush, first broadcast at 14ms, 35ms save stringify, 28ms projection, 2 broadcasts, and 15 MB stringified. The second broadcast is the small `historyStatus` update.
- Verification: `pnpm test`, `pnpm run build`, `pnpm exec playwright test`, and the profile command above passed.

### 2026-05-18: Initial Load and Browser-Created Window Fast Paths

- Baseline before this pass: `pnpm profile:tab-open -- --tabs 50000 --updates 5 --scenario open-tab-storm` was about 488ms perceived, with startup init about 102ms in the Node harness.
- Startup now loads runtime windows and stored state in parallel, skips persistence when the stored tree already matches Firefox, and defers bootstrap/repaired-state persistence until the normal save flush. A stored unchanged 50k-tab startup does not save or stringify.
- Runtime-created tab/window events now try a narrow indexed fast path before full reconciliation. Same-window tab bursts update only the affected window/tab/active nodes, and previously unknown focused windows use `windows.get(windowId)` plus the event tab instead of `windows.getAll()` and broad `tabs.query({})`.
- Sidebar `treeStructureUpdated` handling now has a pure-insert projection fast path for non-search visible insertions. Search-active, collapsed/hidden, restore-candidate, stale, or ambiguous cases still fall back to the existing full render/reconcile paths.
- Profile results after `pnpm run build`:
  - `pnpm profile:tab-open -- --tabs 50000 --updates 5 --scenario open-tab-storm`: 55ms perceived, 102ms with save flush, 1 broadcast, 1 save, 13 MB stringified.
  - `pnpm profile:tab-open -- --tabs 50000 --updates 5 --scenario new-window-storm`: 51ms perceived, 96ms with save flush, 1 broadcast, 1 save, 13 MB stringified.
  - `pnpm profile:tab-open -- --tabs 50000 --scenario startup-stored-unchanged`: 132ms startup, 0 saves, 0 broadcasts, 0 MB stringified.
- Verification: `pnpm test -- src/background/controller.test.ts src/sidebar/visible-tree.test.ts`, `pnpm run build`, and the profile commands above passed.

### 2026-05-18: Known Runtime Fast-Path Patches

- Follow-up target: the new runtime tab/window fast path still called the generic patch builders after making a known local mutation. That meant a 50k-tab same-window/new-window create still paid for global `background.patch.build.*` scans before broadcasting a small patch.
- The runtime fast path now returns the exact `nodeStateUpdated` or `treeStructureUpdated` patch it created and schedules persistence directly. The controller clones the cached runtime index before attempting the fast path so a later fallback cannot inherit partial index mutations.
- Added controller trace coverage proving a browser-created same-window tab/update/activation burst does not call `background.patch.build.treeStructure` or `background.patch.build.nodeState`.
- Before/after using `pnpm profile:tab-open -- --tabs 50000 --updates 5` after `pnpm run build`:
  - `open-tab-storm`: 55ms perceived / 102ms with save flush before; 27ms perceived / 70ms with save flush after.
  - `new-window-storm`: 51ms perceived / 96ms with save flush before; 27ms perceived / 66ms with save flush after.
- Verification: `pnpm test -- src/background/controller.test.ts`, `pnpm run build`, and the profile commands above passed.

### 2026-05-18: Priority Scheduler for Runtime Refresh Backlogs

- Replaced the single FIFO background mutation chain with a small priority scheduler. Commands, undo/redo, removals, session cleanup, and command-owned focus echoes are high priority; browser-created runtime refreshes are low priority and merge into one pending accumulator.
- Runtime events now continue merging while a refresh is queued or running. In-flight work is not interrupted; new events become one trailing low-priority refresh.
- Added controller coverage for `getState` waiting on pending runtime work, commands overtaking queued runtime refreshes, no preemption of in-flight refreshes, and in-flight runtime event trains collapsing to one trailing refresh.
- Added `runtime-refresh-backlog` to `pnpm profile:tab-open`; it measures a command issued behind a queued runtime refresh on a 50k-tab tree.
  - Before scheduler rework, using the new profile script against commit `c3a2756`: `commandWaitMs` 553ms, `runtimeRefreshJobs` 1, `lowRuntimeRefreshJobs` 0.
  - After scheduler rework: `commandWaitMs` 48ms, `runtimeRefreshJobs` 1, `lowRuntimeRefreshJobs` 1.
- Cross-check profiles after `pnpm run build`:
  - `pnpm profile:tab-open -- --tabs 50000 --updates 5 --scenario open-tab-storm`: 26ms perceived, 67ms with save flush.
  - `pnpm profile:tab-open -- --tabs 50000 --updates 5 --scenario new-window-storm`: 26ms perceived, 63ms with save flush.
  - `pnpm profile:tab-open -- --tabs 50000 --scenario startup-stored-unchanged`: 149ms startup, 0 saves, 0 broadcasts.
- Verification: `pnpm test`, `pnpm run build`, and the profile commands above passed.

### 2026-05-18: Staged First Load Snapshot

- Added a storage v2 read model: a manifest, node chunks, order pages, and a bounded initial visible snapshot. After the local export/reset/import decision, saves are v2-only and the full v1 `outlineState` compatibility write is no longer emitted.
- Added `getInitialTreeSnapshot` so the sidebar can render an initial non-search visible slice without waiting for full state hydration. The sidebar delays full `getState` hydration briefly after first paint and gates search/export/import/drag/drop and mutating row actions until hydration completes; live-tab focus remains allowed.
- The v2 manifest carries the first 256 visible rows and only the node records needed for those rows. A 50k-tab first snapshot therefore avoids reading/deserializing the full tree on the first sidebar paint.
- Profile results after `pnpm run build`:
  - `pnpm profile:tab-open -- --tabs 50000 --scenario startup-initial-snapshot`: 1ms initial snapshot, 256 rows/nodes, 441ms full v2 hydration, 0 saves/broadcasts.
  - `pnpm profile:tab-open -- --tabs 50000 --scenario startup-stored-unchanged`: 354ms full startup, 0 saves/broadcasts.
  - `pnpm profile:tab-open -- --tabs 50000 --updates 5 --scenario open-tab-storm`: 27ms perceived, 151ms with save flush, 13 MB stringified.
  - `pnpm profile:tab-open -- --tabs 50000 --updates 5 --scenario new-window-storm`: 26ms perceived, 150ms with save flush, 13 MB stringified.
  - `pnpm profile:tab-open -- --tabs 50000 --scenario runtime-refresh-backlog`: `commandWaitMs` 47ms, 707ms with save flush, 14 MB stringified.
- Tradeoff: dropping v1 writes halves the saved payload and stringify cost, but full v2 hydration is slower than loading the old monolithic v1 blob. That is acceptable only because the sidebar now paints from the 1ms snapshot first and postpones the full load; the next storage target is a faster full v2 materialization path or truly lazy command/search hydration.
- Verification: `pnpm test`, `pnpm run build`, `pnpm exec playwright test --reporter=list`, and the profile commands above passed.
