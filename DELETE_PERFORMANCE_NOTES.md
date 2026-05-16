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
- The current scenario is `single-closed-tab`: sidebar restore-scope analysis, background `restoreNode`, full-state save/broadcast JSON proxy, and one sidebar visible-tree projection.
- Baseline command: `pnpm profile:restore -- --tabs 50000 --target last`.
  - Result before restore model optimization: 186ms total measured, 0ms sidebar scope, 60ms command, 46ms save stringify, 48ms broadcast stringify, 32ms projection, 30 MB stringified.
- Cross-check command: `pnpm profile:restore -- --tabs 50000 --target first`.
  - Result before restore model optimization: 192ms total measured, 0ms sidebar scope, 63ms command, 46ms save stringify, 48ms broadcast stringify, 35ms projection, 30 MB stringified.
