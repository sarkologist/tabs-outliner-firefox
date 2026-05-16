# Single-Node Delete Performance Notes

## Context

Manual QA still shows slow deletion when deleting just one node from a large tree, even after runtime tab removal was batched in `37e2cbc` (`Batch tree close and restore operations`). That batch change mainly helps deletes that need to close many live runtime tabs. It does not remove the dominant costs for deleting one saved/closed node in a large outline.

Current likely bottlenecks:

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

## Agent Instructions

Update this file as you investigate and implement delete performance improvements.

- Keep the `Progress Log` section current. Add a new dated entry for each meaningful experiment, design decision, implementation step, or surprising finding.
- Record commands, benchmark shapes, tree sizes, and before/after numbers when available.
- Preserve prior findings unless they are clearly wrong; if correcting one, add a note explaining why.
- Prefer red-green TDD for behavior changes, following `AGENTS.md`.
- For interleaving-heavy controller/sidebar changes, add deterministic tests that cover duplicate events, stale broadcasts, and repeated renders.
- Do not treat a passing microbenchmark as sufficient; confirm the manual QA path or a realistic browser/sidebar simulation when possible.

## Candidate Fixes

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
