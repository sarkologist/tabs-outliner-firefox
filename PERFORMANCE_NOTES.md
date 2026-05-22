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
- Split sidebar startup into a tiny `sidebar-boot` entrypoint. It requests `getInitialTreeSnapshot`, paints lightweight disabled rows when the snapshot includes the active target, yields for paint, then imports the full sidebar app, which adopts the boot snapshot instead of requesting it again. This targets Firefox's per-window sidebar document reload cost without revealing the wrong top-of-tree slice before active-tab hydration.
- The v2 manifest carries a 256-row visible snapshot plus only the node records needed for those rows. The snapshot is now active-centered when the active tab is outside the first page, and carries real row indices plus `totalRowCount` so the sidebar can scroll to the active target without hydrating the full tree.
- Profile results after `pnpm run build`:
  - `pnpm profile:tab-open -- --tabs 50000 --scenario startup-initial-snapshot`: 1ms initial snapshot, 256 rows/nodes, 435ms full v2 hydration, 0 saves/broadcasts.
  - `pnpm profile:tab-open -- --tabs 50000 --scenario startup-warm-initial-snapshot`: 39ms warm in-memory snapshot, 256 rows/nodes, 50,001 total rows, 0 MB snapshot payload after rounding.
  - `pnpm profile:tab-open -- --tabs 50000 --scenario startup-stored-unchanged`: 354ms full startup, 0 saves/broadcasts.
  - `pnpm profile:tab-open -- --tabs 50000 --updates 5 --scenario open-tab-storm`: 28ms perceived, 165ms with save flush, 13 MB stringified.
  - `pnpm profile:tab-open -- --tabs 50000 --updates 5 --scenario new-window-storm`: 29ms perceived, 162ms with save flush, 13 MB stringified.
  - `pnpm profile:tab-open -- --tabs 50000 --scenario runtime-refresh-backlog`: `commandWaitMs` 47ms, 707ms with save flush, 14 MB stringified.
  - `pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --reporter=list`: first rows at ~63ms focused / ~76ms in the full Playwright run when the active tab is in the snapshot, one initial snapshot request, no full hydration before rows are visible. Coverage includes active-centered sparse snapshots and a fallback for malformed/stale snapshots that miss the active tab.
- Tradeoff: dropping v1 writes halves the saved payload and stringify cost, but full v2 hydration is slower than loading the old monolithic v1 blob. That is acceptable only because the sidebar now paints from the 1ms snapshot first and postpones the full load; the next storage target is a faster full v2 materialization path or truly lazy command/search hydration.
- Verification: `pnpm test`, `pnpm run build`, `pnpm exec playwright test --reporter=list`, and the profile commands above passed.

### 2026-05-19: Incremental v3 Persistence for Repeated Tree Mutations

- Analyzed the provided real extension profile `dist/tabs-outliner-profile-2026-05-19.json`. It contained background-only trace entries; the dominant cost was `background.state.save` at 10 calls / 69,219ms total / 6,922ms average / 13,254ms max. Compact broadcasts were still meaningful at 29 calls / 8,803ms total, while `background.command.run` itself was only 180ms total across 15 commands.
- Replaced default persistence with a v3 storage layout. Nodes are stored in stable hash shards, child order is stored by stable parent/page keys, and the manifest carries counts, root ids, shard settings, and the bounded initial snapshot. `loadState()` now prefers v3 and falls back to v2.
- Added incremental v3 save planning. Once the controller has a persisted v3 baseline, state flushes write only the changed node shards and changed/removed order pages plus the manifest/history. The controller clones the persisted baseline after successful saves so in-place mutations cannot corrupt later diffs. A first save from a v2 or fresh profile still performs a full v3 migration/bootstrap save.
- Fixed the Node profile fake runtimes for the current controller dependencies (`commands` and `storage.onChanged`) and made steady-state command/delete profiles flush the initial baseline before measuring the user operation.
- Profile results after `pnpm run build`:
  - `pnpm profile:command -- --tabs 50000 --scenario move-leaf`: 91ms perceived, first broadcast at 16ms, one save flush at 252ms, 3ms save stringify, 2 MB stringified.
  - `pnpm profile:command -- --tabs 50000 --scenario flatten-window`: 297ms perceived, first broadcast at 151ms, one save flush at 3,250ms, 89ms save stringify, 50 MB stringified. This is still large because the scenario changes the parent id of almost every tab and records/broadcasts a large structural/history delta.
  - `pnpm profile:delete -- --tabs 50000 --target last --count 10`: 777ms perceived, 78ms average, first broadcast at 49ms, one save flush at 395ms, 18ms save stringify, 17 MB stringified. Remaining payload is dominated by repeated structural patches that include the large parent child list.
- Follow-up real Firefox profile from `dist/tabs-outliner-profile-2026-05-19 copy.json`, exported at `2026-05-19T14:34:18.108Z`, covered 9 `wrapNodeInGroup`, 9 `flattenSubtree`, 3 `focusNode`, 2 `closeNode`, and 1 `restoreNode` commands. It still had background-only entries.
- In that post-change trace, `background.state.save` dropped to 9 calls / 6,196ms total / 688ms average / 1,343ms max. The previous trace was 10 calls / 69,219ms total / 6,922ms average / 13,254ms max, so real Firefox save time is now about 11x lower by total and 10x lower by average/max in this manual scenario.
- Runtime broadcasts also improved from 29 calls / 8,803ms total / 304ms average / 1,294ms max to 44 calls / 2,570ms total / 58ms average / 144ms max. Mutation runs improved from 17 calls / 5,486ms total / 323ms average / 1,357ms max to 33 calls / 2,548ms total / 77ms average / 426ms max.
- Verification: `pnpm test`, `pnpm run build`, the synthetic profile commands above, and the copied in-browser `tabsOutlinerProfile` trace all support the v3 persistence win.

### 2026-05-21: Live Leaf Grouping Avoids Full Window Reorders

- Analyzed the in-browser profile `dist/tabs-outliner-profile-2026-05-21.json`. The slow grouping run was dominated by background work after `wrapNodeInGroup`: the command mutation took 1,015ms, `background.command.run` for the grouping command took 686ms, and the browser emitted a burst of tab update echoes (`background.event.tabs.onUpdated`: 38 calls / 16,660ms total / 1,187ms max). Sidebar patch/render work stayed comparatively small (`sidebar.patch.treeStructure`: 8 calls / 237ms total).
- Root cause: live-tab grouping created the destination Firefox window and moved subtree descendants, then called the broad `syncBrowserOrder()` path. For a leaf tab in a large source window, that asked Firefox to move the entire remaining source window plus the new single-tab window even though `windows.create({ tabId })` had already produced the desired browser order.
- Change: `wrapNodeInGroupCommand` now relies on the targeted browser operations already required for grouping. It still moves non-root live subtree descendants into the created window, but it no longer performs the final full-window order sync.
- Added `group-live-leaf` to `pnpm profile:command` so this path is measurable in the Node harness. Using `node scripts/profile-command.mjs --scenario group-live-leaf --tabs 50000`:
  - Before, against the old built `dist`: 5,205ms command time, first broadcast at 5,153ms, 2 `tabs.move` calls, 50,000 moved tab ids, max move batch 49,999.
  - After `pnpm build`: 201ms command time, first broadcast at 144ms, 0 `tabs.move` calls, 0 moved tab ids.
- Verification: targeted red/green coverage in `src/background/commands.test.ts`, `pnpm exec vitest run src/background/commands.test.ts`, `pnpm build`, and the profile command above passed.

### 2026-05-21: Echo-Aware Synthetic Profile Harness

- Added a shared `scripts/profile-harness.mjs` event model. The command, focus, close, delete, restore, and tab-open profile scripts now report `eventCounts` and `eventCount` for `tabs.onCreated`, `tabs.onUpdated`, `tabs.onActivated`, `tabs.onRemoved`, `windows.onFocusChanged`, `windows.onRemoved`, and `sessions.onChanged`.
- The command profile now emits Firefox-like move/create echoes for `tabs.move` and `windows.create({ tabId })`, so relocation scenarios can expose command-owned update/activation/focus traffic instead of only counting direct adapter calls.
- The richer harness immediately exposed the remaining live-grouping echo cost. `node scripts/profile-command.mjs --scenario group-live-leaf --tabs 10000` measured 38ms command time but 16,126ms echo flush time from one `tabs.onUpdated`, one `tabs.onActivated`, and one `windows.onFocusChanged` echo. That makes command-created focus/activation echo absorption the next target before trusting 50k synthetic totals.
- Smoke verification covered the updated profile scripts with 1k fixtures: `profile-command`, `profile-focus`, `profile-close`, `profile-delete`, `profile-restore` in both modes, and `profile-tab-open` event/startup scenarios.

### 2026-05-21: Absorbed Command-Created Grouping Focus Echoes

- Live-tab grouping now marks command-created focused windows and active tabs after `windows.create({ tabId })` returns. If Firefox already queued matching `tabs.onActivated` / `windows.onFocusChanged` runtime refreshes, the controller downgrades or cancels that pending refresh instead of reconciling the full browser snapshot.
- Regression coverage simulates Firefox firing `tabs.onUpdated`, `tabs.onActivated`, and `windows.onFocusChanged` during live grouping and asserts the echoes do not call `windows.getAll()` or `tabs.query()`.
- After `pnpm build`, `node scripts/profile-command.mjs --scenario group-live-leaf --tabs 10000` dropped from 16,126ms echo flush time to 0ms while still reporting the three echoes in `eventCounts`. The 50k run measured 231ms command time, 0ms echo flush time, first broadcast at 177ms, and 0 moved tab ids.
- Verification: `pnpm exec vitest run src/background/controller.test.ts src/background/commands.test.ts`, `pnpm build`, and the profile commands above passed.

### 2026-05-21: Event Echo Asymptotics Audit

- Living code-path audit, not a fresh profile run. Keep this table current as event-echo improvements land. Let `n` be outline nodes, `u` be unique tab events in one coalesced runtime batch, `k` be changed nodes, `c` be runtime-index candidate nodes for a narrow state transition, `d` be opener ancestor depth for a newly created tab, `w` be open browser windows/tabs returned by a runtime snapshot, and `v` be visible sidebar rows. "Warm" means the cached `RuntimeStateIndex` already matches the current state; broad fallback operations may still pay an explicit rebuild and leave the index warm afterward.

| Path | Current Asymptotic | Theoretical Optimum | Gap / Next Work |
| --- | --- | --- | --- |
| Irrelevant `tabs.onUpdated`, command focus active-update drop, delete-owned close echo, sidebar focus noise | `O(1)` | `O(1)` | At optimum. |
| Command focus activation/window-focus echoes | steady-state `O(1)` | `O(1)` | At optimum for the normal command-owned echo path. |
| Command-restored `tabs.onCreated` echo | steady-state `O(u)` | `O(u)` | At optimum for command-created restore echoes. |
| Command-relocated stale tab echoes | steady-state `O(u)` | `O(u)` | The former `O(u * n)` path and the later cold rebuild are gone on normal command transitions. |
| Generic no-op metadata echo | steady-state `O(u)` | `O(u)` | Uses indexed no-op checks when warm; remaining work is entering this path only for relevant metadata events. |
| Runtime-index maintenance for narrow state swaps | `O(c)` plus parent-chain walks for moved/closed candidates; no whole node-table or window-subtree scan | `O(c)` | Per-window closed-restore counts keep this local. Broad import/history/full-reconcile paths still rebuild intentionally. |
| Small runtime update/create fast path | steady-state `O(u + k)` for updates and non-opener creates, `O(u * d + k)` for opener creates; `O(k)` transport | `O(u + k)` CPU, `O(k)` transport | Whole node-table/index copies and normal cold rebuilds are gone. Remaining gap is opener ancestor walking. |
| Compact sidebar patch handling | often `O(v)` for active/row refresh side effects, sometimes fast-path splice/patch work | `O(k + visible-delta)` | Sidebar still rescans visible rows for some patch side effects such as active target and active-window flags. |
| Full runtime reconciliation fallback | `O(w log w + n)` plus browser snapshot cost, then `O(n)` diff or full-state fallback | `O(w log w + n)` | This is the correctness fallback; optimize by avoiding entry into it for narrow events, not by weakening it. |

- Current echo handling has three tiers:
  - Pure drops are `O(1)`: irrelevant `tabs.onUpdated` payloads, command focus active-update echoes, delete-owned close echoes, sidebar-window focus noise, and already-cancelled pending refreshes.
  - Compact visible updates are usually `O(k)` for transport and no full save on the interaction path, but still often `O(n)` background CPU because the controller scans or clones outline-level structures before it can produce the compact patch.
  - Guarded fallbacks remain `O(n)` plus runtime snapshot cost, then `O(n)` patch diff or full-state broadcast fallback.
- Coalescing helps burst shape: runtime refreshes merge by tab id into one low-priority job, so event trains are no longer one full refresh per event. The remaining cost is the work inside the one merged refresh.

### 2026-05-21: Indexed Restored/Relocated Echo Filtering

- Implemented the next audit target: `refreshFromRuntimeNow()` now passes its `RuntimeStateIndex` into command-restored echo consumption, command-relocated stale echo consumption, relocated stale snapshot filtering, activation overrides, and relocated fallback tab reconstruction. These paths now use runtime-id maps instead of `Object.values(state.nodes)` scans.
- Added regression coverage that counts node-table `Object.values()` calls during echo handling:
  - Before the fix, three coalesced command-relocated stale `tabs.onUpdated` echoes performed 4 node-table scans: one cold index build plus one full scan per echo.
  - After the fix, the same scenario allows only the single cold index build and no per-echo node-table scan.
  - Command-restored `tabs.onCreated` echo absorption has the same guard: at most the one cold index build, no extra full node-table scan.
- Verification: `pnpm exec vitest run src/background/controller.test.ts -t "node table scan"`, `pnpm exec vitest run src/background/controller.test.ts`, `pnpm build`, and `pnpm test` passed.

### 2026-05-21: Indexed Command Focus Echoes

- Implemented the next audit follow-up: command-owned focus activation/window-focus echoes now update active tab/window flags through `RuntimeStateIndex` instead of scanning `Object.values(state.nodes)`.
- The indexed path touches only the previous and next active tab/window records, updates `activeTabNodeIdsByWindowId` / `activeWindowNodeId`, and keeps the existing full `refreshFromRuntimeNow()` fallback when the runtime ids are not represented in the index.
- Added scan-count coverage to the focus command echo tests:
  - Same-window `focusNode` echo handling previously did 2 node-table scans: one no-change window focus scan and one tab activation scan.
  - After the fix, same-window and cross-window focus command echoes both perform 0 node-table scans while still avoiding `windows.getAll()`, `tabs.query()`, storage saves, and full-state broadcasts.
- Verification: `pnpm exec vitest run src/background/controller.test.ts -t "focus command"`, `pnpm exec vitest run src/background/controller.test.ts`, `pnpm build`, and `pnpm test` passed.

### 2026-05-21: Runtime Fast Path Avoids Whole-Node Copies

- Implemented the next audit target in `applyRuntimeEventTabsFastPath()`: small runtime tab update/create batches now build a tiny mutation plan, then apply only changed nodes and index entries. The path no longer clones the full runtime index or shallow-copies `state.nodes`.
- Added property-read regression coverage around the warm fast path:
  - Metadata refresh for one tab previously read 2 unrelated tab entries through the node-table copy; it now reads 0 unrelated node entries.
  - Same-window browser-created tab handling previously read 2 unrelated sibling tabs through the node-table copy; it now reads 0 unrelated node entries while preserving opener nesting and active-tab updates.
- Remaining asymptotic gaps: cold runtime-index rebuilds are still `O(n)`, and opener-created tabs still validate the opener by walking ancestors up to the runtime window.
- Verification: `pnpm exec vitest run src/background/controller.test.ts -t "node table scan|per-echo node table scans|runtime tab metadata refreshes|same-window tabs without reading unrelated"`, `pnpm exec vitest run src/background/controller.test.ts`, `pnpm build`, and `pnpm test` passed.

### 2026-05-21: Runtime Index Kept Warm Across State Transitions

- Removed the remaining cold runtime-index rebuild from normal command/native state transitions. State swaps now go through `installStateTransition()`, which updates the existing `RuntimeStateIndex` from command/removal candidate node ids instead of leaving the next echo to rebuild from all `n` nodes.
- Added per-window closed-restore candidate counts so incremental index maintenance does not rescan affected window subtrees.
- Reused the same candidate node set for command-owned restored, relocated, and focus echo bookkeeping, keeping those helpers off `Object.values(state.nodes)` in the hot path.
- Updated generated Firefox-like property traces to assert after every generated operation that the runtime index is warm and matches a rebuilt reference index. The debug comparison covers runtime tab/window maps, live-tab window sets, active maps, and closed-restore candidate counts.
- Tightened the relocated/restored echo scan-count tests from "at most one cold scan" to exactly 0 node-table `Object.values()` calls.
- Verification: `pnpm exec vitest run src/background/controller.test.ts -t "generated|adversarial runtime query skew|live-tab grouping trace|command-relocated stale echoes|command-restored created-tab echoes"`, `pnpm exec vitest run src/background/controller.test.ts`, `pnpm build`, and `pnpm test` passed.

### 2026-05-21: Remaining Asymptotic Targets

- Living code-path audit, not a fresh profile run. Keep this table current as the remaining non-echo bottlenecks move. Let `n` be outline nodes, `u` be unique runtime events, `k` be changed nodes, `d` be ancestor depth, `v` be visible sidebar rows, `r` be search result rows, `w` be browser windows/tabs in a runtime snapshot, and `c` be candidate nodes from a command/history delta.

| Path | Current Asymptotic | Theoretical Optimum | Gap / Next Work |
| --- | --- | --- | --- |
| Opener-created runtime tab placement | `O(u * d + k)` | `O(u + k)` | Ancestor walking validates that an opener belongs under the same runtime window. Add/maintain an owner-window or nearest-window index so opener validation is `O(1)` per event. |
| Sidebar active/row patch side effects | often `O(v + k)` | `O(k + visible-delta)` | Some patch handlers still scan visible rows for active target/window flags and row metadata. Maintain projection indexes by node id/window id/active row. |
| Sidebar search-active patch handling | often rebuilds/searches from state, up to `O(n)` | `O(k + result-delta)` after an index exists | Search projections still favor correctness over incrementality. Needs a maintained search index plus patch rules for result insertion/removal/reorder. |
| Non-local or ambiguous sidebar structure patches | `O(v)` fast-path side effects or full projection rebuild when splice safety is unclear | `O(k + visible-delta)` | Same-parent reorder and simple inserts have fast paths; broader moves need stronger projection metadata to prove splice boundaries without rebuilding. |
| Full runtime reconciliation fallback | `O(w log w + n)` plus browser snapshot cost, then `O(n)` diff or full-state fallback | `O(w + n)` if full validation is required; effectively `O(0)` when avoided | This is the correctness fallback. Main win is preventing narrow events from entering it; secondary win is avoiding avoidable sorting/diff work inside it. |
| Undo/redo/history state application | broad cases rebuild runtime index in `O(n)` | `O(c)` for delta-backed history entries, `O(n)` for true whole-state history | Thread command/history candidate ids into undo/redo so narrow history deltas can use `installStateTransition()` instead of explicit rebuilds. |
| Import/full replacement/initial reconciliation | `O(n)` | `O(n)` | At the lower bound because every node must be ingested, validated, or reconciled. Keep it away from interaction echo paths rather than trying to make it sublinear. |

- Verification: not run; documentation-only audit table.

### 2026-05-21: Nonblocking Sidebar Broadcasts for Repeated Grouping

- Analyzed `dist/tabs-outliner-profile-2026-05-21 copy.json`, which covered 7 repeated `wrapNodeInGroup` clicks with 4 sidebar contexts and about 26.5k visible rows. The grouping mutation itself was not the bottleneck: `background.command.run:wrapNodeInGroup` was 9ms total, and `background.patch.build.treeStructure:wrapNodeInGroup` was 14ms total. The wait came from side work around the mutation queue: `background.runtime.broadcast:treeStructureUpdated` was 32,609ms total / 9,661ms max, `background.runtime.broadcast:historyStatus` was 29,270ms total / 9,660ms max, `background.state.save` was 44,394ms total / 12,348ms max, and `background.diagnostics` was 29,804ms total / 21,206ms max while mostly waiting for the scheduler to go idle.
- Root cause: patched structural commands awaited `runtime.sendMessage()` broadcasts before the mutation resolved. In Firefox, those broadcast promises can remain open for seconds even after the sidebar has visibly applied the patch, so later high-priority grouping commands queued behind broadcast completion. Scheduled saves could also immediately drain another pending save after a slow storage write completed, extending storage pressure during an interaction burst.
- Change: sidebars now open a long-lived `tabs-outliner-sidebar` runtime port. Background UI updates post to connected sidebar ports, with a fire-and-forget `runtime.sendMessage()` fallback for older/no-port contexts, so structural command acknowledgements no longer wait on sidebar broadcast promise resolution. Profile-control pings use the same nonblocking delivery without writing entries into the trace they manage.
- Change: scheduled saves now flush one pending state/history snapshot at a time. If another change arrives while a scheduled save is in flight, the controller re-arms the quiet timer after the write instead of draining the next save immediately. Explicit `flushPendingSaves()` still drains fully for tests and shutdown-style callers.
- Added red/green controller coverage for a never-resolving `treeStructureUpdated` send during repeated `wrapNodeInGroup`, and for rearming the quiet timer when a save is queued during an in-flight scheduled save.
- Verification: `pnpm exec vitest run src/background/controller.test.ts -t "does not wait for sidebar broadcasts|restarts the quiet timer"`, `pnpm exec vitest run src/background/controller.test.ts`, `pnpm test`, `pnpm run build`, and `node scripts/profile-command.mjs --scenario group-live-leaf --tabs 26460` passed. The Node profile does not model Firefox's slow `runtime.sendMessage()` promise resolution, but it remained functionally healthy at 91ms command time / 0ms echo flush / 1 save / 2 broadcasts for the 26.5k-tab grouping scenario.

### 2026-05-21: Longer Quiet Saves for Repeated Flattening

- Analyzed `dist/tabs-outliner-profile-2026-05-21 copy 2.json`, exported at `2026-05-21T19:23:33.029Z`, which covered 13 `flattenSubtree`, 8 `wrapNodeInGroup`, and 1 `promoteChildren` command across 4 sidebar contexts. The previous broadcast fix held: `background.runtime.broadcast` was only 44 calls / 7ms total / 1ms max, and background command work stayed tiny at 22 calls / 33ms total / 3ms max.
- The remaining stall matched storage pressure, not flatten model work. `background.state.save` was 10 calls / 12,682ms total / 8,772ms max. The active sidebar showed `sidebar.command` at 22 calls / 7,670ms total / 1,972ms max, with the biggest command waits overlapping the first long save from about 5.3s to 14.0s in the trace. Sidebar patch/render work stayed bounded: the active sidebar's `sidebar.patch.treeStructure` was 22 calls / 509ms total / 31ms max.
- Change: structural commands now schedule persistence with an interaction save profile: 5s quiet delay and 30s max delay, instead of the default 1s quiet / 5s max save. This keeps repeated flatten/group/promote/delete/import/move bursts visibly responsive while still bounding eventual durability.
- Change: history entries created by structural commands use the same interaction save schedule, and an open pending save batch cannot be downgraded by a later ordinary save request. Saves queued behind an in-flight write preserve the most deferred schedule when the quiet timer is re-armed.
- Added controller coverage for structural commands using the longer quiet save delay and for a later ordinary command not shortening an existing structural save batch.
- Verification: `pnpm exec vitest run src/background/controller.test.ts -t "longer quiet save delay|structural save batch|restarts the quiet timer"`, `pnpm exec vitest run src/background/controller.test.ts`, `pnpm test`, and `pnpm run build` passed.
- Synthetic profile cross-checks after `pnpm run build`:
  - `node scripts/profile-command.mjs --scenario flatten-window --tabs 26460`: 151ms command time, first broadcast at 74ms, 0ms echo flush, explicit save flush 1,366ms, 1 save, 2 broadcasts, 26 MB stringified.
  - `node scripts/profile-command.mjs --scenario group-live-leaf --tabs 26460`: 85ms command time, first broadcast at 60ms, 0ms echo flush, explicit save flush 150ms, 1 save, 2 broadcasts, 1 MB stringified.

### 2026-05-21: Interaction Save Timing for Restore and History Playback

- Follow-up audit after repeated flattening found two remaining user-repeatable paths that still used the normal 1s quiet save schedule: `restoreNode`, and `undo`/`redo` when replaying structural history entries.
- Change: `restoreNode` now uses the interaction save profile. Structural history playback derives its save schedule from the original history entry command, so undo/redo of move, move-to-new-window, group, flatten, promote, delete, or import work also gets the 5s quiet / 30s max save window while non-structural history remains on the normal schedule.
- Added red/green controller coverage proving restore and structural undo/redo do not start storage after only 1s, then flush at the 5s interaction quiet point.
- Verification: `pnpm exec vitest run src/background/controller.test.ts -t "restore commands|structural undo and redo"`, `pnpm exec vitest run src/background/controller.test.ts`, `pnpm test`, and `pnpm run build` passed.
- Synthetic restore cross-checks after `pnpm run build`:
  - `node scripts/profile-restore.mjs --tabs 26460 --target last`: 31ms measured, 6ms command, 23ms save stringify, 8 MB stringified.
  - `node scripts/profile-restore.mjs --scenario controller-event-echo --tabs 26460 --target last`: 85ms command, 0ms event echo, 221ms explicit save flush, 1 save, 1 broadcast.

### 2026-05-22: Autoresearch Restore Candidate Narrowing

- Ran the first autoresearch performance cycle for large-tree interaction latency. Baseline matrix used three sequential runs per scenario after `pnpm run build`; synthetic medians were:
  - Restore transient echo, 50k closed tabs: 219ms total, first broadcast 215ms, 0ms projection, 1 save, 1 broadcast, 2 runtime events.
  - Close, session-before-tabRemoved, 50k tabs: 143ms total, first broadcast 116ms, 0ms projection, 1 save, 1 broadcast, 2 runtime events.
  - Delete 10 leaves, 50k tabs: 715ms total, first broadcast 47ms, 0ms projection, 1 save, 20 patch broadcasts, 10 runtime events.
  - Focus 10 successive tabs, 50k tabs: 194ms total, 0 saves, 10 active broadcasts, 30 runtime events.
  - Move one leaf, 50k tabs: 126ms total, first broadcast 43ms, 43ms tree patch/projection simulation, 1 save, 2 broadcasts, 1 runtime event.
- Selected restore as the first bottleneck because it had the slowest visible-path first broadcast and no projection/full-transport explanation. The issue was restore candidate expansion: a single-tab restore added the owning window to the restore candidate set, then runtime-index candidate collection expanded that window subtree before the compact `nodeStateUpdated` broadcast.
- Change: restore patch candidates now add only the explicitly restored plan nodes, their destination window nodes, and the currently active live window from the warm `RuntimeStateIndex`. Restore runtime-index candidate collection treats that set as exact instead of expanding seed subtrees. This preserves the compact restore patch while avoiding unrelated closed siblings on the interaction path.
- Added red/green controller coverage with a wide stored closed-tab tree. Before the fix, restoring one tab read an unrelated sibling 6 times; after the fix the unrelated sibling is read at most once, from the unavoidable shallow node table copy in `restoreNodes()`.
- After `pnpm run build`, the targeted restore profile medians over three sequential runs were 23ms total, first broadcast 17ms, 0ms projection, 4ms node patch, 1 save, 1 broadcast, and 2 runtime events. A full after-matrix cross-check reported restore at 29ms total / 23ms first broadcast, with close/delete/focus/move counters flat versus baseline. This satisfies the stop condition: first broadcast improved by about 89% and landed under the 75ms target without increasing saves, broadcasts, projection rebuilds, stringified MB, or event counts.
- Verification: `pnpm test -- src/background/controller.test.ts -t "restores one closed tab without traversing unrelated closed siblings"`, `pnpm test`, `pnpm run build`, and the before/after synthetic profile matrices passed. Real sidebar Playwright verification was not run because the accepted change is in background candidate selection and the synthetic restore harness already exercises compact sidebar patch application with no full projection rebuild.

### 2026-05-22: Autoresearch Close Session-Echo Deferral

- Ran the next autoresearch cycle from the post-restore matrix. Close became the next visible-path target: `pnpm profile:close -- --tabs 50000 --target last --order sessionChangedThenTabRemoved` had a median 136ms total and 110ms first broadcast, while restore, delete, and move first broadcasts were already below the 75ms target.
- The tab close order asymmetry identified the issue. `tabRemovedThenSessionChanged` already measured about 53ms total / 51ms first broadcast, but `sessionChangedThenTabRemoved` let the early `sessions.onChanged` echo reconcile missing tabs before the command-owned `tabs.onRemoved` event could close the exact outline node.
- Change: when a `sessions.onChanged` event arrives while command-owned tab removals are still pending, the controller consumes that session echo without entering runtime reconciliation. The matching `tabs.onRemoved` event then performs the existing narrow `closeTab()` path and does not arm an extra future session skip if the pre-removal session echo was already consumed.
- Added red/green controller coverage for `sessionChangedThenTabRemoved`: the early session echo now performs zero unrelated node reads and does not call `tabs.query()` or `windows.getAll()` before the matching remove event closes and broadcasts the node patch.
- After `pnpm run build`, the targeted close profile medians over three sequential runs were 51ms total, 49ms first broadcast, 0ms projection, 2ms node patch, 1 save, 1 broadcast, and 2 runtime events. The full after-matrix reported close at 53ms total / 51ms first broadcast, restore still at 26ms total / 20ms first broadcast, and delete/focus/move counters flat enough to treat as unchanged. This satisfies the stop condition: close first broadcast improved by about 55% and landed under the 75ms target without increasing saves, broadcasts, projection rebuilds, stringified MB, or event counts.
- Verification: `pnpm test -- src/background/controller.test.ts -t "defers command close session echoes"`, `pnpm test`, `pnpm run build`, and the before/after synthetic profile matrices passed.

### 2026-05-22: Autoresearch Trailing Delete Projection Patch

- Ran the next autoresearch cycle from the post-close matrix. Delete was no longer a first-broadcast problem, but repeated last-leaf deletes still showed app-side sidebar patch work: `pnpm profile:delete -- --tabs 50000 --target last --count 10` was about 745ms total / 48ms first broadcast with about 150ms in `treePatchMs` across 10 patch applications.
- Selected the bounded visible-path hypothesis because the generic non-search delete projection handler still allocated a node-row map, filtered the full 50k-row array, rebuilt `visibleNodeIds`, and rebuilt `visibleNodeIdSet` for each trailing leaf delete. For a suffix leaf removal, remaining row indexes do not shift and only ancestor subtree boundaries and child counts need to change.
- Change: non-search trailing visible leaf deletes now take a guarded in-place fast path. It preserves the existing `rows`, `visibleNodeIds`, and `visibleNodeIdSet` containers, splices the suffix, deletes the removed ids from the visible set, adjusts ancestor `subtreeEndIndex` values by removed-row count, and refreshes only updated ancestor rows. The fast path declines active-search projections, active-tab deletion, root/order ambiguity, non-visible descendants, deleted roots, relocated updated rows, and non-suffix deletes.
- Added red/green visible-tree coverage proving a 50k-row trailing leaf delete preserves the projection container identities while updating row metadata, visible ids, counters, and active-tab targeting.
- After `pnpm run build`, the targeted delete profile medians over three sequential runs were 581ms total, 48ms first broadcast, 0ms projection, 1ms `treePatchMs`, 1 save, 20 patch broadcasts, 17 MB stringified, and 10 runtime events. This satisfies the stop condition for the relevant patch-visible update: patch application dropped from about 150ms to 1ms and stayed well below 75ms without increasing full broadcasts, saves, projection builds, stringified MB, or event counts.
- Browser evidence: there is no delete-specific Playwright perf spec yet, so the closest real-sidebar patch checks were run. `tests/playwright/sidebar-cut-paste-group.spec.ts` passed for delete/fallback patch behavior, and `tests/playwright/sidebar-drag-drop-performance.spec.ts` still reported no `sidebar.projection.build` during a 50k-row tree-structure patch, with `sidebar.patch.treeStructure` at 3.1ms.
- Verification: `pnpm test -- src/sidebar/visible-tree.test.ts -t "trailing leaf delete"`, `pnpm test`, `pnpm run build`, `pnpm profile:delete -- --tabs 50000 --target last --count 10` repeated three times, and `pnpm exec playwright test tests/playwright/sidebar-cut-paste-group.spec.ts tests/playwright/sidebar-drag-drop-performance.spec.ts` passed.

### 2026-05-22: Autoresearch Delete Delta Patch Construction

- Ran the next autoresearch cycle from the post-projection-patch matrix. All first-broadcast medians were already under 75ms: restore 25ms total / 19ms first broadcast, close 49ms / 47ms, delete 532ms / 46ms, move 117ms / 45ms, and focus 188ms total with no saves. The remaining delete cost was command throughput for repeated structural deletes, not sidebar projection application: `treePatchMs` was already about 1ms.
- Selected the bounded background hypothesis because each `deleteNode` command still built undo history and the outbound `treeStructureUpdated` patch by diffing the whole node table. A live leaf delete already knows its deleted subtree and affected ancestors, so full node-table `Object.keys()` scans were avoidable for this command without changing the generic structural diff fallback.
- Change: delete commands now compute a small candidate set from the deleted subtree plus its ancestor chain, then use that set for the undo/redo history delta and the broadcast tree patch. The generic `treeStructureUpdateFromStateChange()` path remains in place for broader structural commands.
- Added red/green controller coverage proving a 100-tab live leaf delete performs zero full node-table `Object.keys()` diff scans while still broadcasting the same compact patch and preserving undoable command behavior.
- After `pnpm run build`, the targeted delete profile medians over three sequential runs were 197ms total, 20ms first broadcast, 196ms command time, 0ms event echo, 1ms `treePatchMs`, 1 save, 20 patch/history broadcasts, 17 MB stringified, and 10 runtime events. Compared with the same post-cycle baseline of 532ms total / 46ms first broadcast, this improves repeated-delete command throughput by about 63% and first broadcast by about 57% without increasing saves, broadcasts, projection builds, stringified MB, or event counts.
- Verification: `pnpm test -- src/background/controller.test.ts -t "deletes one live leaf without full node-table diff scans"`, `pnpm run build`, `pnpm profile:delete -- --tabs 50000 --target last --count 10` repeated three times, and `pnpm test` passed. Real sidebar Playwright verification was not run for this cycle because the accepted change is background history/patch construction and does not change sidebar patch application.

### 2026-05-22: Autoresearch Research Stop

- Ran the next autoresearch cycle after the delete delta patch. After `pnpm run build`, the three-run synthetic medians were: restore 29ms total / 23ms first broadcast, close 51ms / 49ms, delete 196ms / 17ms, focus 197ms total with 0 saves and 0 projection work, and move 127ms / 47ms.
- Stop condition reached: every measured first-broadcast path is below 75ms, and the relevant sidebar patch-visible costs are already at or below the target (`delete treePatchMs` 1ms, move first broadcast 47ms). No full `stateUpdated` broadcasts, saves, projection builds, stringified MB, or event counts increased in the post-patch matrix.
- Safety stop for move: `pnpm profile:command -- --tabs 50000 --scenario move-leaf` still reports about 37ms `treePatchMs` because the Node harness rebuilds the projection for any `treeStructureUpdated` message. The real-sidebar Playwright trace disagrees: the 50k same-window leaf drop previously showed no `sidebar.projection.build` and `sidebar.patch.treeStructure` at about 3ms. Optimize the harness before using this synthetic number as an app bottleneck.
- Research stop for focus: `pnpm profile:focus -- --scenario successive-command-event-echo --tabs 50000 --count 10` shows no app-side persistence, transport, stringify, or projection work. The remaining command time is dominated by the fake browser `tabs.update` implementation walking its 50k-tab array and dispatching focus/activation echoes; the app is already avoiding redundant saves and broadcasts.
- Scope stop for delete: after the prior delete delta patch, the remaining repeated-delete total is no longer a patch-visible problem: first broadcast is about 17ms and sidebar patch application is about 1ms. Further reduction would require a broader model/storage representation change or a more realistic runtime-removal harness, not a small bounded patch proposal.
- Verification: `pnpm run build` and the full autoresearch synthetic matrix were run. No code or behavior change was made in this cycle.

### 2026-05-22: Autoresearch Command Harness Patch Alignment

- Followed up on the research-stop finding that `pnpm profile:command -- --tabs 50000 --scenario move-leaf` was pessimistic: the Node harness rebuilt the whole visible projection for every `treeStructureUpdated` message, while the real sidebar already used the same-parent reorder fast path.
- Change: moved the same-parent reorder projection helper from `sidebar.ts` into `visible-tree.ts`, beside the existing insert/delete projection patch helpers, and updated both the real sidebar and `scripts/profile-command.mjs` to use the shared helper. The command harness now tries reorder, insert, and delete projection patches before falling back to `buildVisibleTreeProjection()`.
- Added red/green visible-tree coverage proving a 50k-row same-parent reorder preserves the existing projection arrays and updates row order in place.
- After `pnpm run build`, `pnpm profile:command -- --tabs 50000 --scenario move-leaf` medians over three runs were 91ms total, 45ms first broadcast, 0ms projection, and 6ms `treePatchMs`. Before this harness fix, the same current-code scenario measured about 127ms total, 47ms first broadcast, 37ms projection, and 37ms `treePatchMs`.
- Verification: `pnpm test -- src/sidebar/visible-tree.test.ts -t "same-parent reorder"`, `pnpm run build`, `pnpm profile:command -- --tabs 50000 --scenario move-leaf` repeated three times, `pnpm profile:command -- --tabs 50000 --scenario group-live-leaf`, `pnpm exec playwright test tests/playwright/sidebar-drag-drop-performance.spec.ts`, and `pnpm test` passed.

### 2026-05-22: Sidebar Startup Autoresearch Setup

- Added a dedicated autoresearch setup for initial sidebar hydration lag. The new `pnpm profile:sidebar-startup` matrix runs the existing startup scenarios repeatedly and summarizes the primary hydration score, stored-startup cross-check, warm snapshot timing, snapshot bounds, and zero-save/broadcast/event guardrails.
- Fixed the startup synthetic harness fake `storage.local.get([...keys])` behavior so array-key reads return only requested keys, matching WebExtension storage semantics. This keeps full hydration measurements from accidentally seeing unrelated storage items.
- Added cheap startup marks for initial snapshot load, first rows, full sidebar import, hydration start, and hydration completion. Playwright now verifies rows appear before hydration, controls re-enable after hydration, and the marks are ordered.
- Baseline after `pnpm run build`: `pnpm profile:sidebar-startup -- --tabs 50000 --runs 3 --tag 20260522 --description baseline` reported 657ms primary hydration median, 655ms hydration-only median, 616ms stored-startup median, 34ms warm snapshot median, 256 snapshot rows/nodes, and 0 saves/broadcasts/runtime events.
- Verification: `pnpm test -- src/perf`, `pnpm run build`, `pnpm profile:sidebar-startup -- --tabs 50000 --runs 3 --tag 20260522 --description baseline`, and `pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --reporter=list` passed.

### 2026-05-22: Sidebar Startup Hydration Phase Profiling

- Added optional v3 load phase timing to the startup profile path so `pnpm profile:sidebar-startup` reports median storage hydration phases in the JSON summary without changing the TSV schema. The phase marks cover manifest read, node shard read, stored-node materialization, order-page key generation, order-page reads, child-order attachment, and validation.
- Baseline with phase instrumentation after `pnpm run build`: `pnpm profile:sidebar-startup -- --tabs 50000 --live-tabs 50 --runs 3 --tag 20260522-hydration-phases --baseline-ms 201 --description "hydration phase breakdown" --append-results` reported 259ms primary median, 249ms stored-startup median, and phase medians of 74.7ms `v3.nodeMaterialize`, 17.8ms `v3.orderPageKeys`, and 33.8ms `v3.orderAttach`.
- A manual stored-node materialization experiment was rejected despite noisy total-time improvement because phase data showed `v3.nodeMaterialize` regressed to about 107-109ms.
- Accepted change: v3 hydration now records the subset of stored nodes with children while materializing shards, then generates and attaches order pages only for those parent nodes. In the closed-heavy 50k startup shape this avoids scanning 50k childless tab nodes twice during child-order hydration.
- After `pnpm run build`, `pnpm profile:sidebar-startup -- --tabs 50000 --live-tabs 50 --runs 3 --tag 20260522-hydration-phases --baseline-ms 259 --description "skip childless order hydration" --append-results` reported 176ms primary median, 175ms hydration median, 171ms stored-startup median, 256 snapshot rows/nodes, and 0 saves/broadcasts/runtime events. Phase medians moved to 63.3ms `v3.nodeMaterialize`, 0.1ms `v3.orderPageKeys`, and 0.5ms `v3.orderAttach`.
- Verification: `pnpm test -- src/background/storage-v2.test.ts src/perf/sidebar-startup-profile.test.ts`, `pnpm run build`, `pnpm profile:sidebar-startup -- --tabs 50000 --live-tabs 50 --runs 3 --tag 20260522-hydration-phases --baseline-ms 259 --description "skip childless order hydration" --append-results`, and `pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --reporter=list` passed.

### 2026-05-22: Sidebar Startup Input Delay Instrumentation

- Diagnosed the exported real profile `dist/tabs-outliner-profile-2026-05-22 copy.json`: hover work itself was cheap (`sidebar.hoverGuide` max 2ms), but hover samples had gaps up to 520ms while late `getState` hydration and diagnostics were active. The old trace could show the blocking spans, but not queued input delay directly.
- Added `PerformanceTracer.record()` for externally measured durations so profile summaries can include non-handler durations such as event queue delay.
- Added sidebar trace rows for `sidebar.input.pointerDelay` and `sidebar.input.scrollDelay`, measured as `performance.now() - event.timeStamp`, with details for event type, hydration state, pointer type, and row count. Added an explicit `sidebar.hydration` span around full-state hydration so startup profiles no longer need to infer hydration from generic `sidebar.command getState`.
- Browser check: `pnpm exec playwright test tests/playwright/sidebar-drag-drop-performance.spec.ts --grep "queued pointer"` intentionally delayed synthetic pointer and scroll events by 30ms and reported `sidebar.input.pointerDelay` max 31.2ms and `sidebar.input.scrollDelay` max 32ms in the profile summary.
- Verification: `pnpm test -- src/perf/trace.test.ts`, `pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --grep "hydrates after"`, `pnpm exec playwright test tests/playwright/sidebar-drag-drop-performance.spec.ts --grep "queued pointer"`, and `pnpm run build` passed.

### 2026-05-22: Sidebar Startup Hover Feedback Delay Instrumentation

- Follow-up profile `dist/tabs-outliner-profile-2026-05-22 copy 2.json` showed `sidebar.input.pointerDelay` and `sidebar.input.scrollDelay` both maxing at 1ms, including 122 pointer samples while `hydrating: true`. Full hydration remained the dominant visible span: four sidebars averaged 4093ms and maxed at 4259ms.
- Added `sidebar.input.hoverFeedbackDelay`, measured from the original pointer event timestamp to the rAF-applied hover-guide update. Pointer-delay rows now also include an `outcome` such as `hover-row`, `same-scope`, or a clear reason, plus row/subtree context when available.
- Browser check: `pnpm exec playwright test tests/playwright/sidebar-drag-drop-performance.spec.ts --grep "hover feedback"` intentionally delayed a synthetic pointer event by 30ms and reported `sidebar.input.hoverFeedbackDelay` max 31.7ms with `outcome: "hover-row"` and `reason: "pointer"`.
- Verification: `pnpm exec playwright test tests/playwright/sidebar-drag-drop-performance.spec.ts --grep "hover feedback"`, `pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --grep "hydrates after"`, `pnpm test -- src/perf/trace.test.ts`, and `pnpm run build` passed.

### 2026-05-22: Sidebar Startup Sparse Hover Lookup

- Follow-up profile `dist/tabs-outliner-profile-2026-05-22 copy 3.json` showed pointer and scroll queue delay were not the remaining perceived startup hover issue: `sidebar.input.pointerDelay` and `sidebar.input.scrollDelay` both stayed at max 1ms, and `sidebar.input.hoverFeedbackDelay` stayed at max 4ms once hover feedback actually applied.
- The problematic samples happened during startup hydration with `outcome: "clear-missing-row"` and `rows: 256`. The active-centered sparse first paint rendered DOM rows with absolute `data-row-index` values such as `40000`, but hover lookup treated that value as an array slot in the 256-row sparse projection.
- Added the deterministic autoresearch target `pnpm profile:startup-hover`. Baseline before the fix: `pointerOutcomes: ["clear-missing-row"]`, `clearMissingRowCount: 1`, `hoverFeedbackCount: 0`, `hoverGuideCount: 0`.
- Change: sidebar hover and hover-guide code now resolve rendered rows by `VisibleTreeRow.index`, keeping the dense array fast path and falling back to a small sparse-row scan only when the projection is not indexed densely.
- After the fix, `pnpm profile:startup-hover` reported `pointerOutcomes: ["hover-row"]`, `clearMissingRowCount: 0`, `hoverFeedbackCount: 1`, `hoverGuideCount: 1`, `sidebar.input.pointerDelay` max 0.2ms, `sidebar.input.hoverFeedbackDelay` max 2.8ms, and `sidebar.hoverGuide` max 1ms.
- Verification: `pnpm run build`, `pnpm profile:startup-hover`, `pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --grep "paints an active-centered sparse snapshot"`, and `pnpm exec playwright test tests/playwright/sidebar-drag-drop-performance.spec.ts --grep "hover feedback"` passed.

### 2026-05-22: Sidebar Hover Row Frame Instrumentation

- Follow-up profile `dist/tabs-outliner-profile-2026-05-22 copy 4.json` did not show queued JS input lag while hovering rows: `sidebar.input.pointerDelay` had 205 samples with max 3ms, `sidebar.input.hoverFeedbackDelay` had 134 samples with max 5ms, and `sidebar.hoverGuide` had 134 samples with max 2ms.
- The hover trace was after hydration (`hydrating: false`) and covered repeated movement across 14 rendered row indexes (`26171` through `26184`). The remaining perceived lag is therefore not explained by the existing event-queue or hover-guide JS spans.
- Added `sidebar.input.hoverFrameDelay`, measured from the original pointer event timestamp to the next animation frame after hover-guide DOM mutation. This gives future real profiles a signal for missed-frame visual feedback that `sidebar.input.hoverFeedbackDelay` cannot see.
- Browser check: `pnpm exec playwright test tests/playwright/sidebar-drag-drop-performance.spec.ts --grep "queued pointer"` intentionally delayed a synthetic pointer by 30ms and reported `sidebar.input.hoverFrameDelay` max 36ms, alongside `sidebar.input.hoverFeedbackDelay` max 32ms.
- Startup guard: `pnpm profile:startup-hover` still passed and now reports `sidebar.input.hoverFrameDelay` max 7.3ms for the sparse visible row before hydration completes.

### 2026-05-22: Defer Startup Hydration During Non-Edit Interaction

- Follow-up profile `dist/tabs-outliner-profile-2026-05-22 copy 5.json` showed the missing frame signal: `sidebar.input.pointerDelay` max 1ms, `sidebar.input.hoverFeedbackDelay` max 7ms, and `sidebar.hoverGuide` max 1ms, but `sidebar.input.hoverFrameDelay` had 102 samples with avg 19.2ms and max 246ms.
- The largest `hoverFrameDelay` samples overlapped full-state hydration finishing in multiple sidebar windows. The active sidebar's hover DOM work stayed cheap, but the next frame waited behind full-state `getState` response/render work, including concurrent sidebar hydrations.
- Change: sparse startup hydration now treats pointer hover, pointer leave, and scrolling as non-edit interaction. If full hydration has not started yet, those inputs push the `getState` request back by 1000ms. If hydration has already resolved while startup interaction is active, the full render waits for pending hover frames and a short 120ms input-idle window before replacing the sparse projection.
- Added a deterministic 50k startup hover guard to `pnpm profile:startup-hover`. Before the fix it made a `getState` request during startup hover; after the fix it reports `hydrationRequestsBeforeIdle: 0`, `hydrationRequestsAfterIdle: 1`, `sidebar.input.hoverFrameDelay` max 4.4ms, and `sidebar.input.hoverFeedbackDelay` max 0.3ms.
- Verification: `pnpm run build`, `pnpm profile:startup-hover`, `pnpm exec playwright test tests/playwright/sidebar-drag-drop-performance.spec.ts --grep "queued pointer"`, and `pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --grep "hydrates after"` passed.

### 2026-05-22: Immediate Sparse Startup Hover Guides

- Follow-up profile `dist/tabs-outliner-profile-2026-05-22 copy 6.json` no longer showed the 200ms+ hydration frame stalls. The remaining measured hover cost was one scheduled frame: `sidebar.input.hoverFrameDelay` had 113 samples with p50 20ms, p95 25ms, and max 36ms; `sidebar.input.hoverFeedbackDelay` had p50 6ms, p95 8ms, and max 14ms. All recorded pointer samples were still in sparse startup mode (`hydrating: true`, `rows: 256`).
- Change: sparse startup hover-guide updates now apply immediately instead of waiting for `requestAnimationFrame()`. This is limited to the hydrating sparse projection, where the rendered row set is small, and preserves the coalesced rAF path for the full hydrated projection.
- Deterministic startup guard before the change reported `sidebar.input.hoverFeedbackDelay` max 3ms and `sidebar.input.hoverFrameDelay` max 11.6ms. After the change, `pnpm profile:startup-hover` reported `sidebar.input.hoverFeedbackDelay` max 0.3ms and `sidebar.input.hoverFrameDelay` max 1.7ms for sparse hover, while the hydration-deferral guard stayed green with `sidebar.input.hoverFrameDelay` max 1.8ms.
- Verification: `pnpm run build`, `pnpm profile:startup-hover`, `pnpm exec playwright test tests/playwright/sidebar-drag-drop-performance.spec.ts --grep "queued pointer"`, and `pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --grep "hydrates after"` passed.
