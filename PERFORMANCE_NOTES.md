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
- Runtime trace fix passes now have a hard performance guard: `pnpm perf:runtime-guard` runs budgeted synthetic profiles. `node scripts/analyze-profile-export.mjs <profile.json>` remains optional forensic tooling for fresh current-build in-browser profiles, not a fix acceptance gate.
- Sidebar projection/hydration fix passes now have a hard performance guard: `pnpm perf:sidebar-projection-guard` fails on startup hover/action/hydration regressions and sparse scroll-away row-window regressions.

Known follow-up, intentionally not tackled before longer naturalistic QA:

- Fresh trace `dist/snapshot3.log` showed no full `stateUpdated` broadcasts and no sidebar hotspot, but it did show long trains of queued `tabs.onUpdated` runtime refreshes. If usability still feels sluggish, the next likely target is in-flight runtime-refresh coalescing and/or command priority so stale refresh work cannot sit in front of focus/close/restore commands.

## Current Asymptotics Audit

This is the maintained asymptotics table. Dated tables in the `Progress Log` are historical snapshots. Let `n` be outline nodes, `u` be unique runtime events in one coalesced batch, `k` be changed or transported nodes, `c` be runtime-index candidate nodes for a narrow state transition, `d` be opener ancestor depth, `w` be browser windows/tabs returned by a runtime snapshot, `v` be visible sidebar rows, and `r` be search result rows.

| Path | Current Asymptotic | Theoretical Optimum | Gap / Next Work |
| --- | --- | --- | --- |
| Pure drops: irrelevant `tabs.onUpdated`, command focus active-update echoes, delete/close-owned echoes, sidebar focus noise, absorbed native relocation attach/detach/move echoes | `O(1)` | `O(1)` | At optimum; keep these paths out of saves, broadcasts, diagnostics, projection rebuilds, and runtime snapshots. |
| Command-owned restore and relocation echoes | steady-state `O(u)` with a warm runtime index | `O(u)` | At optimum for command-created restore and relocation echoes. June relocation work keeps existing-window drag/drop echoes off full reconciliation. |
| Small runtime update/create fast path | `O(u + k)` normally; `O(u * d + k)` for opener placement; `O(k)` transport | `O(u + k)` CPU, `O(k)` transport | Remaining gap is opener ancestor validation; maintain owner-window or nearest-window data before trying to remove the `d` factor. |
| Runtime-index maintenance for narrow transitions | `O(c)` | `O(c)` | At optimum for candidate-backed command/native transitions. Broad import and full reconciliation intentionally rebuild in `O(n)`. |
| Structural command patch construction and transport | `O(k)` when candidate ids exist, including non-same-parent `moveNode`; generic fallback `O(n)` | `O(k)` for narrow commands, `O(n)` for broad commands | Keep threading candidate ids through new narrow commands. Reserve generic whole-state diffing for genuinely broad changes. |
| Sidebar patch handling | same-parent reorder, simple insert, trailing leaf delete, and guarded top-level cross-parent visible leaf move avoid full projection rebuilds; current row discovery can still cost `O(v)` before bounded splice/metadata work; ambiguous/search-active paths can reach `O(v)` or `O(n)` | `O(visible-delta + k)` for non-search patches; `O(k + r-delta)` for search patches | Maintain stronger projection indexes before claiming the cross-parent leaf path is fully at the lower bound. Search-active patching still favors correctness. |
| Sparse startup and scroll-away | normal first paint/window fetch is `O(window rows)` and avoids full hydration; fallback/full operations are `O(n)` | `O(window rows)` for sparse interactions, `O(n)` when full tree ownership is required | At the sparse lower bound. Keep export/search/import/restore preflight background-backed so startup does not auto-hydrate. |
| Persistence | small commands append an `O(delta)` v4 journal entry before ack (heavy deltas skip the journal and rely on the deferred snapshot); eventual saves are v4 compactions writing `O(dirty shards)` (full 32-shard rewrite only for broad changes, migration, recovery/replay loads, or failure retries; a clean v4 startup reconciliation now compacts `O(dirty shards)` via material candidates rather than a full rewrite — 2026-06-14); startup load is 2 manifests + 32 shards + journal slots with verified generations and an explicit R0–R4 recovery ladder (order pages eliminated, 2026-06-10 Phase 3). The 256-row boot snapshot is written to its own key on a 10s debounce off the interaction path (P0.5) | `O(delta)` ack-path durability, `O(dirty shards)` compaction — at the target | Keep perceived latency separate from durability. Do not force-drain unrelated broad saves on narrow interaction paths. Remaining gaps: runtime-event checkpoint flushes still force full flushes on some native paths (Phase 3 follow-up), and heavy deltas keep a deferred-save loss window until spill markers + off-path compaction cover them. |
| Full runtime reconciliation fallback | `O(w log w + n)` plus browser snapshot cost, then `O(n)` diff or full-state fallback | `O(w + n)` if full validation is required; effectively `O(0)` when avoided | This is the correctness fallback. Main win is preventing narrow events from entering it; secondary win is trimming avoidable sort/diff work inside it. |

## General Lessons

- Profile before accepting performance changes. Record the scenario, tree size, command/tool, before/after numbers, and whether the measurement is synthetic or in-browser.
- Separate perceived latency from eventual durability. Visible broadcasts should not wait for full `storage.local.set` when a deferred, coalesced save is acceptable.
- Avoid whole-state transport unless the change surface is genuinely whole-tree sized. Prefer compact patches and keep full `getState`/diagnostic paths available for compatibility.
- Preserve node identity for unchanged model nodes. It makes patches smaller and keeps future cache/projection reuse possible.
- Treat no-op and echo events as first-class performance work. A fast operation can still feel slow if stale browser events trigger later snapshots, saves, or broadcasts.
- Coalesce advisory/background work such as diagnostics and persistence. Advisory work should not contend with user-visible mutations.
- When replacing full renders with patches, audit side effects that used to live inside `render()`: scrolling, counters, empty states, active flags, rename/drop cleanup, and diagnostics scheduling.
- Synthetic Node profiles are useful for repeatability, but browser-extension structured cloning, sidebar contexts, storage, and Firefox event ordering can dominate. Use in-browser traces before larger architectural changes.
- Do not ratchet budgets from a known-degraded working tree. Update `scripts/runtime-perf-budgets.json` only after a measured, accepted before/after comparison or an explicit decision to accept the regression.

## Agent Instructions

Update this file as you investigate and implement performance improvements.

- Keep the `Progress Log` section current. Add a new dated entry for each meaningful experiment, design decision, implementation step, or surprising finding.
- Record commands, benchmark shapes, tree sizes, and before/after numbers when available.
- Keep the `Current Asymptotics Audit` table current when performance work changes algorithmic shape, transport shape, save timing, or runtime/sidebar patch behavior. If a performance fix does not change the table, say so in the progress-log entry.
- Treat dated asymptotics tables in the `Progress Log` as historical snapshots; the top-level `Current Asymptotics Audit` section is the maintained source of truth.
- For correctness hunt fix passes, record the Perf Blast Radius tags, selected `perf:runtime-guard` scenarios, and whether any budget moved. Include profile-export notes only when the export was captured from the current build as part of the investigation.
- For sidebar projection/hydration fix passes, run `pnpm perf:sidebar-projection-guard`. It wraps the startup hover and sparse scroll-away profile loops as a hard gate, so `guardFailures` or `status: discard` fail the command instead of relying on manual JSON review.
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

### 2026-06-14: Storage write-cost fix step 2 — journal → IndexedDB (the first real write-cost cut)

Step 2 of the IndexedDB migration (docs/storage-rearchitecture/04-STORAGE-WRITE-COST.md §6). Step 1 introduced the `KeyValueStore` seam; this backs the hot-path outline journal with an extension-owned IndexedDB store, so a journal append stops paying `storage.local`'s whole-store-rewrite cost (0.5–6.7 s per ~1 KB write on the user's profile) and becomes an O(payload) IndexedDB put. The v4 journal/snapshot algorithm is unchanged — only the journal's substrate moves.

- **Adapter:** new `src/background/indexed-db-kv-store.ts` — `indexedDbKvStore(dbName, storeName)`, one out-of-line-keyed object store; `get` (string/array/null), `set`, `remove` each one IndexedDB transaction; lazy open with reset-on-failure. Production (`index.ts`) injects `indexedDbKvStore("tabsOutliner", "kv")` as the controller's `journalStore`; tests keep the `storage.local` pass-through default (no `fake-indexeddb` needed for the existing suite).
- **One-time migration (no data loss):** `migrateJournalStore(from, to)` copies the journal (meta + live slots) from `storage.local` to IndexedDB on the first run, then removes the source — **copy-then-remove**, so a crash mid-migration keeps `storage.local` authoritative (retried next run) or leaves only harmless source garbage (destination authoritative). A no-op once migrated, or when source has no journal, or when `from === to` (the test/default path). The journal **epoch** read moved from the controller's `storage.local` `JOURNAL_META_KEY` read into the coordinator, sourced from the journal's own (post-migration IndexedDB) store, preserving epoch monotonicity / the `journalSeqIncluded` replay contract byte-for-byte.
- **Availability fallback (adversarial-review finding, fixed):** the journal substrate must never block startup (the durable tree is the v4 snapshot, not the journal). If IndexedDB is unavailable/flaky (private browsing, disabled pref, disk pressure, corrupt profile DB), `createAndInitJournal` catches, records a `journalStoreUnavailable` incident, and either keeps using the `storage.local` journal (if migration hasn't completed — authoritative, retry next run) or runs **journal-less** (relies on the deferred snapshot save; prior entries stay safe in the unreachable IndexedDB for a working session). No entries are lost in any branch.
- **Review:** two adversarial subagent passes. Pass 1 confirmed the migration is data-loss-safe under crash/torn/corrupt/over-span metas and found the startup-brick blocker; pass 2 verified the fallback fix sound across 5 properties (journal-less durability via the independent snapshot, epoch monotonicity, no orphan/regression, return-shape, unchanged happy path).
- **Tests:** `indexed-db-kv-store.test.ts` (adapter, `fake-indexeddb`); `outline-journal-indexeddb.test.ts` (journal round-trip on IndexedDB; migration preserves entries+epoch and drains the source; idempotent; no-op when source empty; **leaves source intact when the destination write fails**; does not clobber an already-migrated destination); controller test that an unavailable journal store still boots + stays functional journal-less.
- **`Current Asymptotics Audit` (Persistence row):** the journal-append substrate changes from O(total `storage.local` store) to O(payload) IndexedDB; the v4 shard saves still go to `storage.local` (Step 3 moves those — the ceiling-lifter). Field re-measure of `background.journal.append` p95 against the 30 ms trigger pending the next in-browser profile.
- **Guards:** full vitest 760 (+10), typecheck (src + test) + build clean, `perf-runtime-guard --hard-only` PASS (9), `perf:sidebar-projection-guard` PASS (2), **storage-fault lane** PASS (fault corpus + crash soak — the journal's storage.local fault behavior is unchanged; tests run the journal on the in-memory store via the default).

### 2026-06-14: Storage write-cost fix step 1 — `KeyValueStore` port for the journal (pure refactor)

First step of the IndexedDB migration (docs/storage-rearchitecture/04-STORAGE-WRITE-COST.md §6). The profiles established that the remaining per-action background cost is two environment-bound halves: browser-API reconciliation (`tabs.query`/`windows.getAll`, not app-side reducible — see the focus/activation entries) and **`storage.local` writes** (the legacy Firefox JSON backend rewrites the whole area on every `set`, so even a ~1 KB journal append costs O(total store) = 0.5–6.7 s in this profile's census probes). The fix for the storage half is to move the bulk store (hot-path journal first, node shards later) onto an extension-owned IndexedDB store where a put is O(payload).

This step introduces the seam only — **no behavior change, no IndexedDB yet**:
- New `src/background/key-value-store.ts`: a minimal `KeyValueStore` port (`get`/`set`/`remove`, the exact subset the journal uses) + `storageLocalKvStore(api)`, a byte-for-byte `storage.local` pass-through.
- `createOutlineJournal` now takes a `KeyValueStore` instead of the raw `WebExtensionBrowser`; the persistence coordinator constructs it from an injectable `journalStore` dep that defaults to `storageLocalKvStore(api)`. Step 2 swaps that default for an IndexedDB-backed store with no further journal changes.
- The fake `storage.local` already satisfies the port, so journal unit tests inject `faulty.api.storage.local` directly (no new mock — the §6.3 objection answered).

- **Tests:** new `key-value-store.test.ts` (adapter delegates the string/array/null `get` shapes, set/remove, and propagates `set` failures through the adapter).
- **`Current Asymptotics Audit`:** unchanged — `storageLocalKvStore` is a pass-through; this is a no-op refactor whose only purpose is to make the journal's substrate injectable. The Persistence-row write cost changes in step 2 (journal → IDB).
- **Guards:** full vitest 750 (+2), typecheck (src + test) + build clean, `perf-runtime-guard --hard-only` PASS (9), `perf:sidebar-projection-guard` PASS (2), and the **storage-fault lane** (W-4/W-8, required for save-shape-adjacent changes) PASS — fault corpus (torn/failed/crash/restart) + crash soak, exercising the journal through the new seam.

### 2026-06-14: Skip the runtime refresh when focus leaves all browser windows (WINDOW_ID_NONE)

The first interaction trace carrying both #12 (focus-gated hydration) and #13 (boot-snapshot coalescing) — `tabs-outliner-profile-2026-06-14(1) copy 6.json`, a 93 s window-switching capture — confirmed the startup herd is gone (**zero** `background.state.initialSnapshot.load` in the window). The newly-dominant cost is **`background.event.windows.onFocusChanged`**: 9 events, avg 334 ms, max 790 ms. Firefox fires focus changes in pairs — first `windowId: -1` (`WINDOW_ID_NONE`, focus leaving all windows) then the new window id — and the trace shows the `-1` half consistently costs 207–790 ms. Reason: `recordNativeWindowFocused(-1)` is never a command fast-path, so the handler falls to `queueRuntimeRefresh([], { focusWindowId: -1 })`, and that refresh is **never absorbed** (`focusedWindowIds.has(-1)` is always false — no real window is focused), so it always runs the full `O(w log w + n)` reconciliation + browser snapshot on the single background thread, right when the user is switching windows/apps. This compounds with #12, which made focus-gain also hydrate the newly-focused sidebar.

Fix: in the `windows.onFocusChanged` listener, return early when `windowId === api.windows.WINDOW_ID_NONE`. Focus leaving all browser windows (switching to another app, or the transient blur Firefox fires mid window-to-window switch) does not change the tab tree, and the immediately-following focus-gain event reconciles. The `focusWindowId` was used only for the absorption check and the command fast path, and clears no active-window/UI state, so the skip is purely the removal of wasted reconciliation.

- **Tests:** new controller test — `onFocusChanged(WINDOW_ID_NONE)` makes no `windows.getAll` / `tabs.query`, emits no broadcast, writes no storage; a real window gaining native focus still reconciles (positive control proving the skip is specific to `-1`). Teeth-verified: `windows.getAll` is called once for `-1` without the skip.
- **`Current Asymptotics Audit` (Full runtime reconciliation fallback row):** unchanged shape; this removes a class of events (focus-loss) that previously *entered* the fallback unconditionally — i.e. it widens "preventing narrow events from entering it," the stated main win for that row.
- **Deliberately not in this pass:** the real-window focus-gain half still does a full `queueRuntimeRefresh` (187–779 ms here). Native focus could likely use the cheap in-place focus update (`focusRuntimeWindowInPlace`, as the command path does) since `tabs.on*` events keep the tree current regardless of focus — but that changes correctness-sensitive reconciliation semantics and needs the runtime-domain regression-trace analysis first, so it is left as a noted follow-up.
- **Guards:** `perf-runtime-guard --hard-only` PASS (9), `perf:sidebar-projection-guard` PASS (2), 748 vitest (+1), typecheck (src + test) + build clean. Runtime-event-path change (no save-shape change), so the storage-fault lane is not implicated.

### 2026-06-14: Coalesce concurrent boot-snapshot reads (collapse the startup sidebar herd)

A post-#11 clean steady-state startup trace (`tabs-outliner-profile-2026-06-14(1) copy 5.json`, 7.3s background capture) confirmed the one-time costs are tamed — `state.load` 1348 ms (whole 36 MB store, not the old 27 s leak), `diagnostics.getWindows` max **7 ms** (the #11 seed works, was 6275 ms), store healthy at 36 MB / 256-shard layout (the #10 32→256 re-shard fired mid-day; census confirms ~258 keys). The remaining startup contention is a **thundering herd**: the user keeps many windows open, so every sidebar boots together, and while the full state is still loading they ALL take the `loadInitialTreeSnapshot` branch — the trace shows **9× `background.state.initialSnapshot.load`** clustered at startup (89–269 ms each, serialized on the single background thread ≈ 1.4 s of contention) each reading the *same* ~1.2 MB persisted boot-snapshot key. (The storage backend's per-op latency is also wildly variable — the census's own 1 KB probe `set` spiked to 5–6.7 s several times in this log — which is the environment factor that makes any duplicated read expensive.)

Fix: single-flight `loadInitialTreeSnapshot` in `controller.ts initialTreeSnapshot()` via `initialTreeSnapshotLoadInFlight ??= …` (the same pattern as the adjacent `historyLoadInFlight`/`diagnosticsInFlight`). Concurrent boot reads now share one storage read; the promise clears on settle, and once the full state is warm the in-memory fast path (`initialTreeSnapshotFromFullState`) serves with no storage read at all. Safe because the read is a pure `storage.local.get` + clone whose result is structure-cloned again per `sendMessage` recipient, so handing the same in-flight result to every caller cannot let one sidebar mutate another's.

- **Tests:** new controller test — 8 concurrent `getInitialTreeSnapshot` against a not-yet-loaded background make **one** boot-snapshot read (verified to have teeth: **8** without the coalesce), and a warm-state request makes **zero**.
- **`Current Asymptotics Audit` (Sparse startup row):** per-call shape unchanged (`O(window rows)` warm projection, or one `O(snapshot)` read cold); this removes the `W×` multiplier on the cold boot-snapshot *storage read* during the pre-state startup window — `W` reads → `1`.
- **Diagnostics herd note:** the trace also shows 5× `getDiagnostics` at startup → only 3 computes (single-flight + TTL cache already in place); the extra recomputes are interleaved startup runtime events calling `invalidateDiagnosticsRuntimeCache`. Left alone — advisory, already mostly coalesced, and touchier than the read collapse.
- **Guards:** `perf-runtime-guard --hard-only` PASS (9), `perf:sidebar-projection-guard` PASS (2), 747 vitest (+1), typecheck (src + test) + build clean. Read-only change (no save-shape change), so the storage-fault lane is not implicated.

### 2026-06-14: Focus-gated full-state hydration (only the focused window's sidebar holds the full tree)

The remaining steady-state cost with many windows open is structural: the user keeps 7-9 windows open, so 7-9 sidebars each independently hydrate and hold their *own* full copy of the ~25k-node tree at startup. That is `W × O(n)` hydration work and `W` resident copies of a large store, even though only one window is focused/visible at a time. The single background thread also serves all `W` hydration `getState` pulls, so the unfocused sidebars' pulls queue in front of the focused one's.

Fix (branch `perf/lazy-inactive-sidebar`, `src/sidebar/sidebar.ts`): full hydration is now gated on window focus. `scheduleFullStateHydration` returns early when `sidebarWindowFocused === false` (the window is known-unfocused); a background sidebar stays on the sparse projection (boot snapshot + on-demand viewport slices), which still displays and scrolls the tree normally. Focus is captured at boot in `loadSidebarWindowId` via `currentSidebarWindow()` (renamed from `currentSidebarWindowId`; it now returns the raw `{ id, focused }` `windows.getCurrent` info) and tracked live by a `windows.onFocusChanged` listener (`registerSidebarWindowFocusListener`). On focus-gain a deferred sidebar hydrates immediately (`scheduleFullStateHydration(0)`); losing focus keeps the already-hydrated state (dropping it would re-pay hydration on every window switch — memory reclaim on blur is a deliberately deferred phase 2).

- **Unchanged where focus is unknowable.** `sidebarWindowFocused` is `undefined` when there is no `windows` API or `getCurrent` rejects; the gate only skips on an explicit `false`, so headless/test/no-API contexts keep the prior always-hydrate behavior. The sparse-display paths are untouched, so a background sidebar looks identical to a focused one until the user interacts past the loaded window rows.
- **Tests:** Playwright `sidebar-first-paint` (10 passed) confirms a single focused window still hydrates and the gate does not break "replaces a stale boot snapshot with background truth" or "does not auto-hydrate after sparse first paint". The focus listener itself is exercised through the existing sparse/hydration suite (the node vitest env has no `windows.onFocusChanged`, so the registration early-returns there — same path as the `undefined`-focus fallback).
- **`Current Asymptotics Audit`:** the per-sidebar path shapes are unchanged — a focused sidebar's first paint is still `O(window rows)` and its full hydration still `O(n)`. What drops is the cross-sidebar startup multiplier: from `W × O(n)` hydration (every open sidebar) to `1 × O(n)` (focused) `+ (W−1) × O(window rows)` (background), with `W−1` fewer resident full-tree copies. The "Sparse startup and scroll-away" row already documents sparse as the lower bound; this keeps unfocused sidebars at it instead of each independently going `O(n)`.
- **Guards:** `perf-runtime-guard --hard-only` PASS (9 scenarios, hard counters), `perf:sidebar-projection-guard` PASS (2 scenarios), 746 vitest (no change — sidebar focus path is Playwright/manual-QA verified), typecheck (src + test) + build clean.

### 2026-06-14: Seed the diagnostics window snapshot at startup (keep getWindows off the startup path)

A clean-but-slow-system steady-state trace showed the first `getDiagnostics` poll issuing its own browser `windows.getAll` on the startup-critical path. Under the load of the startup request burst that call was profiled at ~6.3s (vs ~70ms for the same `getNormalWindows` run calm during the load), and `getState`/hydration queued behind it (~6s). The diagnostics window snapshot (`diagnosticsRuntimeWindows`) is reused between polls and only refetched after a runtime event — but it was cold at startup, so the first poll paid the full query exactly when the thread was busiest.

`initializeState` already runs `getNormalWindows` (fast, as part of the load), so it now seeds `diagnosticsRuntimeWindows` with that snapshot before returning. The first poll recomputes off the seed with no browser query; runtime events clear+refresh it as before. We deliberately do NOT also precompute `lastDiagnostics` (that would add a second startup node-table traversal and regress the runtime-index-warming budget). Diagnostics is advisory (Class C), so reusing the startup snapshot for the first readout is correct — a runtime event between load and the first poll clears the seed and forces a fresh query.

- Tests: new controller test (first poll after startup makes no `windows.getAll`); the three diagnostics-cache tests (coalescing / result-freshness / snapshot-reuse) now invalidate the seed with a tab event first so they still exercise a cold-cache fetch.
- `Current Asymptotics Audit`: unchanged (diagnostics is advisory Class C, off the durable-state asymptotics).
- Guards: runtime-guard --hard-only PASS (9), sidebar-projection-guard PASS (2), 746 vitest (+1), typecheck + build clean.

### 2026-06-14: Finer v4 sharding (32 -> 256) to cut per-save bytes on the interaction path

After the leak fix, the representative trace (`tabs-outliner-profile-2026-06-14(1).json`, clean 36 MB store) showed the remaining intermittent lag is bg-thread occupation from storage saves (~360-573 ms) plus runtime-event reconciliation (~400 ms) — both serialize the single background thread, delaying command acks / broadcasts / sidebar requests. The save cost is driven by **shard size**: a v4 save rewrites whole dirty shards, and at 32 shards a 25k-node store is ~1 MB/shard, so even a single-node change wrote ~1 MB.

Measured on a realistic many-windows/few-tabs tree (≈ the user's shape), a one-tab save: **272 KB @32 → 85 KB @256** (the synthetic tree's 3,900 roots inflate the manifest floor; the user's store has 43 roots, so the shard dominates and the real win is ~8×: ~1 MB → ~140 KB → ~500 ms → ~70-100 ms). Bumping `STATE_V4_NODE_SHARD_COUNT` 32 -> 256 keeps ~100-140 nodes/shard.

- **Migration (no data loss):** a store written at a legacy count still loads cleanly at r0 — `isStateV4Manifest` accepts `STATE_V4_LEGACY_SHARD_COUNTS` ({32}) in addition to the current count, and the loader reads whatever shard keys the manifest lists. The coordinator forces ONE full compaction when `currentV4Snapshot.manifest.shardGenerations.length !== STATE_V4_NODE_SHARD_COUNT`, re-sharding to 256; the old-count shard keys are GC'd over the next saves + the orphan sweep. Without the forced full, an incremental save would stamp the new-layout shards the old manifest never had at generation 0 (non-existent keys) and corrupt the snapshot.
- **Tests:** storage-v4 re-shard round-trip (load 32-shard store -> full compaction -> reload exact state at 256); controller test that a 32-shard store re-shards on the first save (forced full compaction) and reloads exactly; existing literal-32 assertions switched to the constant.
- **Trade-off:** load reads 256 shard keys instead of 32 (same total bytes; one batched `storage.local.get`). The manifest's `shardGenerations` is 256 ints (~1 KB, negligible). Real load latency at 256 keys is not measurable in the node harness — to watch on the next in-browser profile. The fixed key floor also rose from 33 to 257 keys: a full write always emits every shard index (empty shards included), so even a brand-new ~5-node profile stores ~257 keys (~14 KB). Cheap relative to the per-save win on real stores, but noted since the storage rework is about key/byte accounting.
- **`Current Asymptotics Audit` (Persistence row):** unchanged shape (`O(dirty shards)`), but the per-shard constant drops ~8x, so a single-node save now writes ~tens of KB instead of ~1 MB.
- **Guards:** runtime-guard --hard-only PASS (9), sidebar-projection-guard PASS (2), storage-fault lane PASS (fault corpus + crash soak), 744 vitest (+2), typecheck + build clean.

### 2026-06-14: Pause diagnostics polling in hidden sidebars

With the leak fixed, the remaining startup-period background cost was `sidebar.diagnostics`: each of the user's 7-9 open sidebars polls `getDiagnostics` (a background `getNormalWindows` ~0.4-1.5s) even when not visible. `loadDiagnostics` now early-returns when `document.hidden`, and a `visibilitychange` listener reschedules a load when the sidebar becomes visible — so only visible sidebars poll. `isDocumentHidden` is an injected dep on `createDiagnosticsNotice`. Advisory path (does not affect persisted state). Verified via `perf:sidebar-projection-guard` PASS + Playwright first-paint (visible path unchanged); not unit-testable in the node vitest env (the notice instantiates a `window.setTimeout` scheduler). `Current Asymptotics Audit`: unchanged (diagnostics is advisory Class C, off the durable-state asymptotics). Guards: runtime-guard --hard-only PASS, sidebar-projection-guard PASS, 742 vitest, typecheck + build clean.

### 2026-06-14: Fix the v4 shard-GC leak (1.95 GB / 584 orphaned generations) — the real startup-cost root

In-browser census (incident log) on the user's store showed `totalBytes: 1.95 GB`, `nodeShardKeyCount: 2801`, `nodeShardDistinctGenerations: 584` — the v4 store is meant to keep ~2 generations (~64 shard keys). Old generations were never collected, growing ~1 generation per startup. `loadStateV4` stayed fast (<0.84s — it reads only the current 32 shards via the manifest), but any whole-store read — a cold load, and the profiling census's `storage.local.get(null)` — had to chew 1.95 GB → ~27s, and that read (e.g. fired by enabling profiling) serialized startup's `journal.init`/`getState`/hydration behind it (~27–33s). **The orphaned shards are superseded copies of the tree, not data; reclaiming them loses nothing** (the user explicitly ruled out pruning history — this isn't that).

- **Leak cause:** `adoptLoadedV4Snapshot` reset `previousV4Snapshot = undefined` at startup, so the first post-startup compaction passed no `collect` and never GC'd the manifest slot it overwrote. Over hundreds of startups that slot's superseded shards accumulated.
- **Leak fix (commit pending):** `loadStateV4` now returns the other stored slot's manifest (`fallbackManifest`/`fallbackSlot`); `adoptLoadedV4Snapshot` seeds `previousV4Snapshot` from it, so the first save collects normally. New controller test asserts the first post-startup save collects the evicted slot's superseded shard (would leak without the seed).
- **Backlog cleanup:** `sweepOrphanedV4Shards(api)` removes every `outline:v4:nodes:*` key not referenced by either stored manifest (both slots → both stay loadable; never sweeps with no parseable manifest). Run once per session, deferred 8s off the startup critical path, fire-and-forget; records an `orphanShardSweep` incident. Self-limiting once the backlog clears + the leak is closed. 3 storage-v4 tests: reclaims orphans while preserving the exact model state + R1 slot; no-op when all referenced; never sweeps blind.
- **Impact:** store returns to ~MB, so whole-store reads (cold load, census) drop from ~27s to sub-second; startup stops queuing behind them. The earlier incremental-startup-save fix (d133d9f) is what keeps per-save cost `O(dirty shards)`; this stops the store itself from growing unboundedly.
- **Guards (run before commit this time):** `perf-runtime-guard --hard-only` PASS (9), `perf:sidebar-projection-guard` PASS (2), storage-fault lane PASS (fault corpus 13 + crash soak), 742 vitest (+4), typecheck + build clean.
- **`Current Asymptotics Audit`:** the Persistence-row load shape (current manifest + 32 shards) is unchanged; this fix removes an unbounded *constant-factor* leak (stored bytes were growing without bound), restoring the intended ~2-generation footprint so whole-store reads stay bounded.

### 2026-06-14: UI smoothness — sync hover, optimistic closed-delete, incremental startup save

Three changes from in-browser `tabsOutlinerProfile` traces on a ~25.7k-node store (61 live). Branch `perf/ui-interaction-smoothness`. **Process note:** the guards below were run *after* the commits (a5bb527, d133d9f), not before, contrary to the AGENTS.md pre-commit rule — recorded here to remediate. No budget moved.

- **Sync hover (a5bb527, sidebar projection/patch path).** Hover guide now applies synchronously in the pointerover/scroll handler instead of via `requestAnimationFrame`, so it paints on the input frame instead of waiting a (throttled) animation frame. Profile before: `hoverFrameDelay` avg 82ms / max 966ms with the sidebar main thread ~98% idle (frame starvation, not CPU). After (06-14 trace): avg 6ms / max 30ms; `perf:sidebar-projection-guard` `sparseHoverFrameMaxMs=5.3`.
- **Optimistic closed-delete (a5bb527, sidebar patch path).** Deleting a fully-closed subtree predicts the mutation locally with the same pure fns the background uses (`deleteNode` + `treeStructureUpdateFromCandidateNodeIds`) and applies it immediately; the echoed broadcast is absorbed as a no-op (`isAlreadyAppliedDeletePatch`, guards against double-decrementing counts). Removes the ~400-490ms wait for the broadcast that the background's storage write delays. Live deletes keep the await-broadcast path.
- **Incremental startup save (d133d9f, save/compaction path).** A clean r0 v4 startup did a full 32-shard compaction (`fullCompaction:true`) — profiled at 32-38s, saturating the bg thread so every startup slice/diagnostic/interaction queued behind it; the sparse boot-snapshot + journal writes were mostly queue-wait behind it. Cause: startup `scheduleStateSave` passed no candidate ids, and `fullCompaction = !candidateNodeIds || !currentV4Snapshot` forces full (currentV4Snapshot is already seeded at boot via `adoptLoadedV4Snapshot`). Fix: pass the nodes materially changed by startup reconciliation (`changedNodeIdsSinceBaseline` vs the loaded snapshot) as candidates → `O(dirty shards)`. Material (not identity) diff so a reconciliation that rebuilds equal node objects still yields a tight dirty set; clean shards keep their stored value — the same contract every post-startup save and the `statesMateriallyEqual` save gate already use. Recovery/repair/journal-replay loads keep the full rewrite via `requiresFullSave`; bootstrap (no v4) stays full. Round-trip test asserts a clean v4 startup reconciliation saves with `fullCompaction:false`, `<32` dirty shards, and reloads with every closed shard intact + the reconciled live tab durable.
- **Caveat (not yet field-verified):** the startup-save win is proportional to how few shards the changed nodes hit (32 fixed shards ≈ 806 nodes each). With changes spread across many shards it approaches the old full cost; never worse. The user's 06-14 re-profile was captured ~78s before this build and does not yet reflect the fix.
- **Guards:** `node scripts/perf-runtime-guard.mjs --hard-only` PASS (9 scenarios, all hard counters). `perf:sidebar-projection-guard` PASS (2 scenarios). Local timing budgets red (`command-refresh-noop`, `command-group-live-leaf`) — pre-existing and documented under the 2026-06-10 P0.1 entry (zero-save CPU variance / never-moved budgets); `main` fails them identically. Storage-fault lane (W-4/W-8, required for save-shape changes) PASS: fault corpus (torn/failed/crash/restart, 13 tests) + crash soak ("keeps generated compactions, journal replays, crashes, and restarts loadable as the exact model state"). 738 vitest (+2), typecheck, build, Playwright first-paint/delete/hover all green.
- **`Current Asymptotics Audit` (Persistence row):** updated — the startup save is no longer an unconditional full rewrite; a clean v4 load now compacts `O(dirty shards)` like every other save. Startup *load* (read all 32 shards into the in-memory model) is unchanged `O(n)`; that and the fixed 806-node shard granularity are the remaining O(total) lower bounds, addressed only by finer-grained / per-record storage and lazy closed-history paging — not by discarding data.

### 2026-06-10: Storage Rearchitecture Phase 0 (docs/storage-rearchitecture)

This and the following dated entries implement Phase 0 of `docs/storage-rearchitecture/02-IMPLEMENTATION-PLAN.md` — contained fixes that re-green the hard counters and close loss vectors without the v4 architecture change.

#### P0.1: Incident log is anomalies-only + in-memory cache

- Root cause of the `saves: 2 > 1` guard regression (introduced by `72bc680`/`369c317`): `saveStateAndHistoryNowWithTrace` recorded a `saveFlush` incident on *every* flush, and `scripts/profile-storage-metrics.mjs` counts any non-lifecycle-journal `set` as a `save`. The incident-log `set` was the second save.
- Change: the save flush now records an incident (`saveFlushAnomaly`) only when the flush sharply reduces node counts — `closedCountDelta <= SAVE_FLUSH_ANOMALY_CLOSED_DELTA (-25)` or `nodeCountDelta <= SAVE_FLUSH_ANOMALY_NODE_DELTA (-50)` — the signature of the data-loss family. Routine flushes are silent.
- Change: `incident-log.ts` keeps one in-memory copy of the log per writer context (a `WeakMap` keyed by the storage api) and appends with a single `set` and no per-append `get`. The background page is the only writer, so the cache stays authoritative.
- Tests (red first): `incident-log.test.ts` "appends without re-reading storage after the first append"; `controller.test.ts` "does not write an incident log entry for a routine save flush" and "writes a saveFlushAnomaly incident when a flush sharply reduces the closed node count". Updated two existing controller tests and the profile test that asserted a routine `saveFlush` entry.
- Guard before (this machine, after `pnpm build`): all six mutating scenarios `saves=2` (FAIL hard-max). Guard after: every mutating scenario `saves=1`; **all `saves` hard-counter failures gone**. `journalWrites`/`storageSetCalls` unchanged except dropping the incident-log `set`.
- Residual guard misses after P0.1 are timing-only and pre-existing on this machine, documented as never-moved budgets: `restore-last-transient-echo firstBroadcastMs` 36–45 vs budget 20 (see 2026-06-03 entry — over the 23 limit since before the data-loss fix), `command-group-live-leaf firstBroadcastMs` 152–160 vs budget 120 (see 2026-06-05 entries, repeatedly 154–178), and `command-refresh-noop totalMeasuredMs` 141–157 vs budget 123 (a no-op scenario with zero saves/journal — pure CPU variance). None is in the save path; none is touched by P0.1. No runtime perf budget moved.
- `Current Asymptotics Audit`: unchanged (incident logging is diagnostic Class C, off the durable-state asymptotics).

#### P0.3: Save failures retry with backoff and force a full save

- Root cause (loss vector V2 / RC-4): a failed `flushScheduledSave` caught the error, only wrote a trace mark, and had already dequeued `pendingSaveState` — so the change was silently dropped with no retry, and if the failed `set` partially applied, the next incremental save diffed against a now-wrong `lastPersistedState`.
- Change: on a state-save rejection the controller now sets `lastPersistedState = undefined` (so the retry rewrites the full state rather than trusting an incremental baseline against an unknown partial write), re-queues the failed snapshot unless a newer mutation superseded it, sets `pendingSaveRequiresFullDiff = true`, records a `stateSaveFailed` incident, and re-arms the save timer with `SAVE_FAILURE_BACKOFF_MS = [1000, 4000, 16000]` (reset to index 0 on the next success). The error is re-thrown so the timer path still swallows it and explicit `flushPendingSaves()` keeps its existing throw contract; the re-throw also makes `flushPendingSaves()` do exactly one attempt then defer to the backoff timer, so it cannot spin.
- Tests (red first): `controller.test.ts` "re-schedules and retries after a failed state save" (fail one `storage.local.set` on the v3 manifest, advance fake timers, assert a `stateSaveFailed` incident then the backoff retry persists the change) and "forces a full-diff save after a save failure" (assert the retry's `background.state.save.v3.changeBuild` detail is `fullSave: true`).
- Guard: unchanged from P0.1 — all hard counters green; only the chronic `restore-last-transient-echo firstBroadcastMs` timing miss remains (pre-existing; see 2026-06-03). No budget moved.
- `Current Asymptotics Audit`: unchanged (retry/backoff is on the failure path; steady-state save shape is unchanged).

#### P0.4: Salvage v3 loads instead of silently falling back to stale v2 (V1)

- Root cause (loss vector V1 / RC-3, highest severity): any v3 consistency failure at load — an unparseable shard, a missing/mismatched order page, a `childIds.length !== childCount` — made `loadStateV3FromManifest` return `undefined`, which silently fell back to the frozen v2 manifest (never updated since migration) or, failing that, to `bootstrapFromWindows`. The next save then overwrote good v3 keys with the rolled-back/empty tree. This is the most probable mechanism behind "my outline lost weeks of data".
- Change (`storage.ts`): the v3 loader now salvages. It skips unparseable shards (keeping every shard that parses), keeps the valid prefix of each parent's child order when a page is missing, then runs the existing `normalizeLoadedV3Structure` (which re-roots the children it could not place). It returns `undefined` only when shards were expected and *none* parsed. `loadStateWithMetadata` now distinguishes "v3 manifest absent" (legitimate pre-migration → v2) from "v3 manifest present but unloadable", flags salvaged loads (`salvaged`, `repair`, `requiresFullSave`), marks a v2 result used under a present v3 manifest as `staleV2Fallback`, and returns an empty salvaged v3 state rather than letting the caller bootstrap when a v3 manifest exists but nothing loaded.
- Change (`controller.ts` startup): records `v3LoadSalvaged` (with repair counts) when a salvage occurred, `staleV2FallbackUsed` when a present v3 manifest forced a v2 rollback, and `bootstrapSkippedStoredDataPresent` when it is about to bootstrap while stored outline keys exist. `requiresFullSave` from salvage already forces a full rewrite to the current physical layout.
- Tests (red first): `storage-v2.test.ts` — "salvages v3 when an order page is missing", "salvages v3 when a shard is corrupt", "does not fall back to v2 when a v3 manifest exists"; `controller.test.ts` — "startup salvages closed v3 nodes instead of bootstrapping over them".
- Guard: unchanged — all hard counters green; only the chronic `firstBroadcastMs` timing items remain. No budget moved. Full suite: 675 passed.
- `Current Asymptotics Audit`: Persistence/load lower bound unchanged — salvage reads the same shard + order-page keys; it changes the *failure* response (recover + flag, not silent fallback), not the steady-state load shape.

#### P0.5: Boot snapshot moved off the per-save path

- Root cause (RC-6, the biggest per-save line): `stateV3ManifestForState` rebuilt the 256-row initial snapshot via `initialTreeSnapshotForState` and embedded it in the manifest, so every flush — even a one-node change — did an O(n) projection walk and reserialized the snapshot.
- Change (`storage.ts`): the v3 manifest no longer embeds `initialSnapshot` (kept optional for back-compat reads); it carries `bootSnapshotRevision`. The snapshot now lives in its own key `outlineState:v3:bootSnapshot` via `outlineStateV3BootSnapshotItem`. `loadInitialTreeSnapshot` reads that key first and falls back to the embedded field for older manifests, then v2. `isStateV3Manifest` accepts manifests with or without the inline snapshot.
- Change (`controller.ts`): the boot snapshot — a cold-start-only first-paint cache (Class C, read only before full state loads) — is written on a 10s debounce armed by `scheduleStateSave`, never inside a save flush. Staleness up to the debounce is harmless: full hydration supersedes it immediately after first paint. The boot-snapshot key is exempted from the "state save" counters in both the controller test helper and `scripts/profile-storage-metrics.mjs` (it is derived data, like the lifecycle journal).
- Tests: `storage-v2.test.ts` — "loads the boot snapshot from its own key before v2", "does not embed the initial snapshot in v3 save manifests", "loads the embedded snapshot from older v3 manifests for back-compat"; updated the manifest-key read assertions.
- Guard before→after (this machine): `delete-last-tab` mbStringified 3→2, `restore-last-transient-echo` 1→0; `totalWithSaveFlushMs` fell across mutating scenarios (e.g. delete ~202→159, group ~333→231) because the per-save projection rebuild is gone. The residual mbStringified (2–3 on 50k-tab scenarios) is the v3 changed-shard/order-page layout, which the v4 architecture (Phases 1–3) removes — not the snapshot. All hard counters green; only the chronic `firstBroadcastMs`/noop timing items remain. No budget moved.
- `Current Asymptotics Audit` (Persistence row): the eventual v3 save is now genuinely O(changed shards/pages) with no hidden O(n) snapshot rebuild on the flush; the boot snapshot is a separate debounced O(n) write capped at once per 10s and off the interaction path.

#### P0.6: Wire the baseline-detach guard on the align path (V5)

- Correction to the diagnosis: `detachPersistedStateBaselineForMutation` is *not* dead code — it already has four call sites covering the in-place mutators (`activateRuntimeTabInPlace`, `focusRuntimeWindowInPlace`, `applyPlannedStateUpdates`, and the toggle/expand command branch). The remaining uncovered in-place mutator is `alignKnownRuntimeWindowProvenance`, called on the refresh path *before* its `installStateTransition`.
- Change: `alignKnownRuntimeWindowProvenance` now calls `detachPersistedStateBaselineForMutation()` before mutating `node.runtimeProvenance` in place, so a provenance change applied while the persisted-state baseline still aliases live state (the 0ms clone has not run) is visible to the next save diff (V5 / RC-8).
- Deviation from the plan: I did **not** add the detach to `installStateTransition`. Commands install copy-on-write `next` states (new node objects), so they cannot poison the baseline; adding an eager detach there forces a synchronous O(n) `cloneOutlineState` on every command transition (it pulls the deferred baseline clone back onto the interaction path) and broke the "restores one closed tab without traversing unrelated closed siblings" traversal-budget test (reads 1→2). The align path is the only real gap.
- Test status (honest): a deterministic red-first regression test for this race is impractical with the current harness — fake timers hang the runtime-refresh flow (it awaits event processing that needs timer advancement), and real timers let the 0ms baseline clone fire before the race can trigger. The race needs torn-timing control, which is exactly what the Phase 1 fault-injection lane (03-WORKFLOW-FIXES W-4) is for; the deterministic test is deferred there. The fix mirrors the four existing tested detach call sites and is validated by the full suite (677 passing) and a green-hard-counter guard with no close-scenario (refresh→align) regression.
- Guard: unchanged — only the chronic `restore-last-transient-echo firstBroadcastMs` timing item fails. No budget moved.

### 2026-06-10: Code-review fixes (6 confirmed durability bugs)

A max-effort multi-agent review of the branch confirmed six bugs, all storage-fault/concurrency interleavings. Fixes:

- **Migration on degraded loads**: salvaged/staleV2Fallback legacy loads no longer migrate (incident `v4MigrationDeferredDegradedLoad`; legacy keys stay authoritative for the next clean startup). Legacy-key cleanup after a v4 load now requires migration evidence (`outline:v4:migrationBackupMeta`), so a degraded session's v4 saves can never trigger legacy deletion (`legacyKeysRetainedWithoutMigrationEvidence` surfaces the stuck state). The backup now expires after 7 days via the tiny meta key; the failure rollback covers every written key incl. the boot snapshot.
- **Shadow-paging GC (I-5)**: `removeKeysAfterCommit` now lists only keys NEITHER stored manifest references — the writer takes `collect` (the manifest evicted from the target slot, two compactions back) and the controller tracks `previousV4Snapshot`. A torn-but-resolved compaction can no longer delete the R1 fallback slot's shards; the property test's crash mode now also runs the post-commit GC.
- **Journal serialization**: `append`/`prune`/`init` run through an internal single-flight op queue, eliminating the same-seq/same-slot overwrite between overlapping event-flush/command appends and the prune-vs-append meta corruption. New concurrency tests.
- **Spill authority unified**: the journal module is the single spill judge (node+childIds weight, then a byte cap); the controller's three duplicated weight pre-checks are deleted; `appendOutlineJournalItems` returns `spilled` and tightens the save schedule itself, and command appenders return false on spill so the checkpoint flush runs — closing the byte-heavy/node-light loss window. The JournalFullError retry now re-enters the tracked path.
- **Undo/redo journaled (I-1)**: closed-only history replays (no lifecycle intent) append a `historyReplay` entry before ack, so a restart can no longer resurrect an undone change by replaying only the original command's entry. Runtime-touching undos keep lifecycle-journal recovery exclusively (journaling both double-applied the delta — caught by the regression trace corpus).
- Incident-log cache updates after the write lands; the FNV-1a shard hash is now one shared `outlineNodeShardIndex`.
- Validation: 713 tests (4 new), hard-only guard PASS, no budget moved.

### 2026-06-10: budget: command-move-leaf journalWrites 0 -> 2

- Scenario: `command-move-leaf` (same-parent reorder of the last tab in a 50,000-tab window).
- Old/new: `journalWrites` 0 → 2. All other budget values unchanged.
- Measured cause: the reorder's delta includes the 50k-childIds window node, which exceeds the journal weight cap, so the command now durably records a `{spill: true}` marker (write 1) per the spill rule, and the post-flush journal prune advances `outline:v4:journal:meta` (write 2). Both are journal-class small-byte writes (`journalKbStringified` ≈ 1), not state saves; `saves` stays 1.
- Why fundamental rather than incidental: the marker is the architecture's designed record that a change bypassed the journal — it is what lets the loader detect an un-folded broad change (`journalSpillGap`) and what Phase 4 needs before candidate threading can be deleted (the journal becomes the compactor's only dirty-source, with markers forcing full compactions). Suppressing the write would re-create the silent heavy-delta gap.

### 2026-06-10: Spill markers for heavy deltas (Phase 4 prerequisite)

Heavy command deltas (weight over `JOURNAL_SPILL_NODE_LIMIT` 2,000 — any edit touching a huge-childIds parent) previously skipped the journal **silently**: the deferred snapshot was their only durability, the loader had no way to know a broad change was un-journaled, and Phase 4 cannot delete candidate threading while the journal is blind to heavy edits.

- Change: the heavy branch of `appendCommandJournal`/`appendCommandJournalForKnownNodeIds` now appends a delta-less `{spill: true}` marker entry (the journal module also accepts explicit spill items) and **tightens the pending save to the normal schedule** via `tightenPendingSaveScheduleAfterSpill` — `schedulePendingSave` alone is an escalator (`moreDeferredSaveSchedule` never tightens), so the schedule is reset first. A heavy structural edit's loss window drops from the 5/30 s interaction deferral to the 1/5 s normal one. Startup replay that crosses an unfolded marker records a `journalSpillGap` incident (the snapshot may miss that change; bounded by the tightened schedule).
- Tests: journal module explicit-spill round-trip; controller "appends a spill marker for a too-heavy command delta and tightens the save schedule" (2,500-tab delete: marker entry without delta in the slot write, snapshot save fires at 1 s instead of 5 s).
- Guard impact: `command-move-leaf` (same-parent reorder in the 50k window) now performs 2 journal-class writes (spill marker + journal-meta prune after the flush), exceeding its `journalWrites: 0` budget — raised in the accompanying `budget:` commit per the W-2 contract. All other scenarios absorbed the marker within existing budgets (delete/close/restore/group observed `journalWrites=1`, burst 20). 708 tests passing.
- Event paths intentionally do not write markers (their heavy deltas keep the checkpoint flush, which is itself the immediate durability).

### 2026-06-10: Workflow fixes W-1/W-2/W-4/W-5/W-8 (symmetric gates, fault lane, CI hard counters)

Implements the process half of the rearchitecture pack (docs/storage-rearchitecture/03-WORKFLOW-FIXES.md; status note added there). No behavior changes to product code.

- **W-1**: AGENTS.md now states that any change touching save/load/compaction, journaling, broadcast, reconciliation, projection, or patch paths is perf-relevant regardless of motive, with a red guard blocking the commit. The projection hunt's Fix Gate cross-references the runtime guard for background-touching fixes. `scripts/perf-runtime-guard.mjs` gained `--hard-only` / `RUNTIME_PERF_GUARD_HARD_ONLY=1` (timing failures report-only, hard counters still fail — verified PASS on this machine where the two chronic timing budgets miss), and CI gained a `runtime-perf-hard-counters` job running it on every PR. Timing remains a blocking local gate.
- **W-2**: budget changes to `scripts/runtime-perf-budgets.json` are reviewed contract changes (commit prefixed `budget:` + a notes entry with scenario, old/new, measured cause, and why fundamental); loosening without that is disallowed.
- **W-4**: new `storage-faults` autoresearch lane (CORRECTNESS_GUARDS.md + `autoresearch-accept.mjs` LANE_COMMANDS): the deterministic torn/failed/corrupt/recovery tests plus the storage-v4 generated crash/restart property test at soak scale. That property test is now soak-scalable (`generatedTraceConfig`, 16 seeds × 400 steps under `GENERATED_TRACE_SOAK=1`, ~0.4 s) and included in `pnpm test:soak`, so the nightly soak fault-injects with fresh seeds. The runtime hunt coverage matrix gained a "Process death / storage fault" axis. The storage lane's vitest corpus now includes `storage-v4.test.ts` and `outline-journal.test.ts`.
- **W-5**: RUNTIME_TRACE_HUNT_GUIDE.md gained an "Incident Log Triage" section — non-routine incidents during dogfooding are treated like failing hunt traces (freeze, reduce, file).
- **W-8**: save-timing/save-shape changes must run the storage-fault lane before acceptance (AGENTS.md bullet + the hunt guide's fix-pass gate).
- Not done: W-7 (evidence-log archival). W-6's calendar conditions (3 consecutive ≥10k-op fault soaks, 14 clean dogfood days, zero closed-subtree-guard fires) start counting now.

### 2026-06-10: Storage Rearchitecture Phase 3 follow-up (event journaling, in-place command gap, burst guard scenario)

Completes the Phase 3 durability story for runtime events and closes a command-path journal gap the new guard scenario exposed.

- **Runtime-event coalesced journaling (Class B)**: native closes (tab/window/window-closing), session-changed reconciles, the runtime fast path, and accepted refresh snapshots now queue their deltas into a 50 ms quiet / 250 ms max coalescer (`EVENT_JOURNAL_*`); a burst becomes one journal slot write. The fast path mutates state in place, so its delta is built from the broadcast update payload rather than a state diff. Queued deltas drain into command appends first (journal seq order stays chronological — replay applies absolute records in seq order), are dropped when a compaction of the current state subsumes them (restored on compaction failure), and fall back silently to the deferred save when an append fails or a delta exceeds the weight cap. The event-path checkpoint flushes (`flushRuntimeTruthFastPathSaveIfNeeded`, refresh-snapshot `flushRuntimeTruthSaveIfNeeded`) now run **only when the delta was not queued** — the ≤250 ms journal window replaces the synchronous full flush, per the architecture's Class B tolerance.
- **In-place command journal gap (found by the burst scenario)**: `toggleCollapsed`/`expandAncestors` use the deliberate mutable command path (`previous === next`), so the diff-based `appendCommandJournal` recorded nothing — collapse changes (Class A) silently lacked I-1 coverage. The burst measurement made it visible (13 journal writes instead of 20). New `appendCommandJournalForKnownNodeIds` builds the delta directly from the known changed node ids; the burst now journals 20/20.
- **New guard scenario `compaction-after-burst`** (budget addition per plan step 7): 20 mixed mutations (rename/toggle/same-parent move) on a 1,000-tab window, then one flush. Measured: `saves=1` (one compaction), `journalWrites=20`, `totalWithSaveFlushMs` 40–50, `mbStringified=1`. Budgets: `saves: 1`, `journalWrites: 21`, `totalMeasuredMs: 60`, `totalWithSaveFlushMs: 75`, `firstBroadcastMs: 20`, `stateBroadcasts/statusBroadcasts: 20`.
- Harness fix: `profile-command.mjs`'s `isV3StateSave` (gating the structural-save-pressure delay on the v3 manifest key) was dead under v4 — replaced with `isStateSnapshotSave` matching both manifest formats.
- Tests: new — browser-created window **provenance** survives an abrupt restart before any save via the event journal (the data reconcile cannot reconstruct; the RT-252 family), burst-coalescing into one slot write, queued-delta subsumption by a flush. Two existing tests that hung the *next* `storage.local.set` unconditionally (to assert acks don't wait on persistence) now hang only snapshot writes — the small journal append before ack is by design. Full suite 705 passing; guard hard counters all green including the new scenario.
- Docs: ARCHITECTURE.md Persistence section rewritten for the v4 journal+snapshot design (recovery ladder, durability classes, migration); Tradeoffs updated; new `INVARIANTS.md` registry (I-1..I-15 with owners and enforcing tests) per 03-WORKFLOW-FIXES W-3.

### 2026-06-10: Storage Rearchitecture Phase 3 (v4 snapshot live: verified load, compaction, migration)

The v4 store is now the live persistence format. `storage-v4.ts` (landed unwired in the prior commit) provides 32 generation-stamped node shards with `childIds` inline — order pages are gone — plus double-buffered manifests; the controller now loads it with the explicit recovery ladder and compacts to it instead of writing v3.

- **Load**: startup tries `loadStateV4` first (R0 verified clean → R1 other-slot fallback when the newest snapshot is torn → R2 salvage of every readable shard + structural repair; each non-R0 outcome records a `v4LoadRecovery` incident and forces a fresh full generation). Journal replay on top is unchanged. `bootstrapFromWindows` still requires no stored data of any version (I-6).
- **Migration**: with no v4 keys, the legacy v3/v2 load (including the P0.4 salvage ladder) feeds a one-time migration: write the complete v4 store + boot snapshot, read it back and `statesMateriallyEqual`-verify, write a portable-tree backup to `outline:v4:migrationBackup`, then delete all legacy keys. Any failure removes the just-written v4 keys (so a bad migration is never trusted as authoritative), records `v4MigrationFailed`, keeps legacy keys, and retries next startup. A v4 load that still sees legacy keys (migration crashed after commit) deletes them off-path.
- **Compaction**: `saveStateAndHistoryNowWithTrace` now builds a v4 snapshot — dirty shards = the flush's candidate shards ∪ shards touched by journal appends since the last stamped compaction; no candidates (broad changes, startup rewrites, failure retries) → full. Old-generation shard keys are removed after the set commits (failures are harmless garbage). The journal is pruned to the stamped seq after every successful compaction. History still rides in the same `set` under `outlineHistory`.
- **Two v3-era behaviors became wrong under v4 and were fixed**: (1) the `candidateSaveRequiresFullDiff` promotions (root change / count decrease / candidate-missing) forced full 32-shard rewrites on every delete — deleted; a dirty shard is rebuilt wholesale from current state, so deletions need no promotion (the guard caught this: `delete-last-tab` mbStringified 14 → 3). (2) `persistWithNodeStateUpdate` without caller candidates broadcast a patch enumerating the changed nodes but scheduled with `undefined` candidates — harmless under v3 diffing, a full compaction under v4; it now derives candidates from the patch (close scenarios: 12 MB full rewrites → 1 dirty shard, mbStringified 0).
- **Guard** (this machine): all hard counters green, no budget moved. `totalWithSaveFlushMs` roughly halved again: close 132–148 → 77–80, delete 126–148 → 64, restore → 92, move → 138–165. `mbStringified`: close 0, delete 3 (the 50k-childIds window shard), move 2, group 3. Only the two chronic, documented `firstBroadcastMs` timing budgets still miss (restore, group — never-moved since 2026-06-03/05).
- **Validation**: 702 unit/controller/storage tests; Playwright 277 passed; `pnpm test:soak` passed except one **pre-existing** model finding a fresh random seed discovered (reproduced byte-identically at `369c317`; filed as RT-253), plus a second pre-existing abrupt-restart provenance finding from a domain-trace hunt run (RT-252, also reproduced at `369c317`). Neither is a storage regression. New controller tests: v3→v4 migration (clean, write-failure retry with legacy kept authoritative, v2-only), startup salvage, I-1 across a crash-mid-compaction (hung set + abrupt restart).
- `Current Asymptotics Audit` (Persistence row) now reads: interaction-path durability O(delta) journal append; eventual saves are O(dirty shards) v4 compactions (full only for broad/no-candidate changes); startup load is 2 manifests + 32 shards + journal slots (order-page fanout eliminated).

### 2026-06-10: Storage Rearchitecture Phase 2, slice 2 (conditional checkpoint-flush removal)

Removes the runtime-truth checkpoint flush from the command ack path **when the journal captured the command's delta** — the real-Firefox latency win deferred from P0.2 (RC-5). A small provenance-changing command (restore into a small window, group/move creating a command window) previously forced a full `flushPendingSaves()` (~0.7 s real Firefox) before its ack; it now appends an O(delta) journal entry (provenance rides in the delta) and skips the flush.

- Mechanism: `appendCommandJournal` now returns whether it durably journaled the delta. Each provenance/placement-checkpointed command branch (restore, delete, structural group/move, same-parent reorder, cross-parent move) appends first, then calls its `flushRuntimeProvenance/TruthSaveIfNeeded` **only when the append did not journal** (empty or too-heavy delta). The journal and the checkpoint predicate use the same candidate ids, so a captured delta always includes the provenance change the flush would have persisted — making the skip safe.
- Why it stays correct for heavy deltas: an edit touching a 50k-child window exceeds the journal weight limit and is not journaled, so its branch still flushes (durability preserved until Phase 3's off-path compaction covers heavy deltas too). The runtime guard's scenarios are all heavy, so they keep flushing — `saves`/`journalWrites` unchanged, all hard counters green, no budget moved.
- Scope: command paths only. Runtime-event checkpoint flushes (native close) and event coalescing are deferred — removing them needs coalesced event journaling, which lands with Phase 3 (native creates have no lifecycle-journal backstop, so they cannot lose their flush without journal coverage first).
- Tests: adapted "defers command-window structural move persistence until an explicit save flush" — a small `moveSubtreeToTopLevel` now asserts a `background.journal.append` trace (journaled, flush skipped) instead of the `runtimeTruthCheckpoint.deferred` trace, and still verifies the move + `commandCreated` provenance survive an abrupt restart. Full suite 693 passing.
- `Current Asymptotics Audit`: small provenance-changing commands now ack after an O(delta) journal append with no synchronous full flush; heavy edits retain the deferred-flush behavior. Audit row update pending Phase 3.

### 2026-06-10: Storage Rearchitecture Phase 2, slice 1 (journal wired for commands, I-1)

Wires the v4 journal into the controller as before-ack durability, keeping the deferred v3 save and the runtime-truth checkpoint flushes as the double-write safety net (slice 2 removes the checkpoints). Delivers invariant **I-1** (an acked mutation survives a background restart) for journaled commands, including across a torn v3 write — the case the pre-journal architecture could not survive.

- Lifecycle: the controller constructs the journal at startup with a fresh epoch (prior + 1), `init()`s it, and replays any entries with `seq > manifest.journalSeqIncluded` onto the loaded snapshot before reconciliation (recording a `journalReplay` incident and forcing a full v3 rewrite so the next startup does not re-replay). `saveStateAndHistory` stamps `journalSeqIncluded` (the v3 manifest gained the field) when it serializes the current state; the journal is pruned past that seq once it accumulates `JOURNAL_PRUNE_THRESHOLD` (32) entries. `JournalFullError`/byte-spill trigger an interim compaction (flush v3 + prune); Phase 3 replaces that with the shadow-paged compactor.
- Command journaling: each specific command branch appends its delta (built via `outlineMaterialDelta`, narrowed to the branch's candidate ids) before its ack. **A delta too heavy to journal cheaply is skipped** — node count plus total `childIds` across updated nodes over `JOURNAL_SPILL_NODE_LIMIT` (2000) — so an edit touching a 50k-child window (delete/move/group/restore in the guard scenarios) falls back to the order-paged v3 save and the lifecycle journal rather than serializing a megabyte delta on the ack path. `importTree` and the broad/visible-first generic fallback are not journaled before ack (deferred to slice 2's coalescer). The journal append (slot+meta) and prune (meta) are exempted from the state-save counters in `scripts/profile-storage-metrics.mjs` and the controller test helper.
- Tests: `controller.test.ts` — `I-1: an acked rename survives an abrupt restart before any state save` and `I-1: an acked rename survives a torn v3 save across restart via journal replay` (rename has no lifecycle-journal entry, so it isolates the outline journal). Adapted the one lifecycle-recovery test whose `changedState` flipped to false because the outline journal now replays the outline delta first.
- Guard: **all hard counters green with no budget change** — the guard scenarios all touch the 50k-child window, so their deltas exceed the journal weight limit and skip journaling (journalWrites/saves unchanged). `totalWithSaveFlushMs` is flat-to-lower. Only the chronic `restore-last-transient-echo firstBroadcastMs` timing item remains. Full suite 693 passing.
- `Current Asymptotics Audit`: interaction-path durability for small commands is now `O(delta)` journal append before ack; large/broad edits stay on the deferred v3 path. The audit row is unchanged pending slice 2 (checkpoint-flush removal) and Phase 3 (v4 snapshot).

### 2026-06-10: Storage Rearchitecture Phase 1 (journal module, unwired)

Phase 1 of `docs/storage-rearchitecture/02-IMPLEMENTATION-PLAN.md`: the pure v4 mutation-journal module and the fault-injection storage harness. **No controller or save/load wiring** — this is groundwork for Phase 2/3, so the runtime guard and asymptotics audit are unchanged.

- New `src/background/outline-journal.ts`: `createOutlineJournal(api, {epoch, now})` with `init`/`append`/`prune`/`pendingEntryCount`/`pendingBytes`, plus pure `journalTouchedNodeIds` and `replayJournal`, and a typed `JournalFullError`. Entries carry `{seq, epoch, at, kind, label?, delta?, spill?}`; deltas over `JOURNAL_SPILL_NODE_LIMIT` (2000 nodes) or `JOURNAL_SPILL_BYTE_LIMIT` (512 KB) are recorded as `spill: true` markers without the delta. Storage layout: a 64-slot ring (`outline:v4:journal:slot:<i>`) plus `outline:v4:journal:meta`; one `set` per append writes a single slot and advances meta together; a full ring throws `JournalFullError` so the controller compacts; `init` truncates at the last good seq on a corrupt slot and reports `truncatedAtSeq`.
- New `src/test/faulty-storage.test-support.ts`: an in-memory `storage.local` with `failNextSet()`, `tearNextSet(keepKeys)` (crash-consistent partial multi-key write), and `setLatencyMs()` — the harness that makes torn-write/failed-set/restart scenarios testable for Phases 2-3 and the storage-fault lane (03-WORKFLOW-FIXES W-4).
- Tests: `outline-journal.test.ts` (8 — round-trip, spill marker, ring-full, prune, replay, corrupt-slot truncation, touched-id union, failed-append-leaves-state-unchanged) and `faulty-storage.test.ts` (6). Full suite 691 passing; tsc clean; runtime guard unchanged (hard counters green).

### 2026-06-06: Promoted Current Asymptotics Audit

- Promoted the event-echo and remaining-target asymptotics tables out of the dated May 21 progress entries into a stable `Current Asymptotics Audit` section near the top of this file.
- Updated repo and performance-note agent instructions so future performance work must update that table when algorithmic shape, transport shape, save timing, or runtime/sidebar patch behavior changes, or explicitly note that it is unchanged.
- No code behavior changed; no performance profiles were rerun. Verification: `git diff --check` passed.

### 2026-06-06: Cross-Parent Move Structural Patch Fast Path

- Change: non-same-parent `moveNode` now builds `treeStructureUpdated` from `runtimeIndexCandidateNodeIds` instead of falling through to `persistWithBestEffortPatch()` and whole-node-table diff scans. The same-parent reorder path remains on `sameParentReorderUpdated`.
- Change: sidebar projection handling now has a guarded non-search fast path for a single visible leaf moving between two visible expanded top-level parents. It splices existing row/id arrays in place, refreshes the moved row and affected parent metadata, and falls back for search-active, sparse, collapsed/hidden, subtree, deleted-row, multi-move, or active-moved cases. The synthetic command profiler was wired to the same helper.
- Baseline reference from current samples before this pass: `command-existing-window-relocation-echo --tabs 50000` had `projectionMs=108`, `treePatchMs=115`, `firstBroadcastMs=148`, no full-state broadcast, one state save, and five native echo events.
- Final acceptance: `pnpm build` passed. Three final-dist runs of `node scripts/profile-command.mjs --scenario command-existing-window-relocation-echo --tabs 50000` reported `projectionMs=0` each time, `treePatchMs=5,5,5`, `firstBroadcastMs=123,123,122`, no full-state broadcasts, one state save, one storage set, and the same five native echo events.
- Regression profiles on final dist: `move-leaf --tabs 50000` kept `sameParentReorderBroadcasts=1`, `treeStructureBroadcasts=0`, `projectionMs=0`, `treePatchMs=0`; `move-top-level-live-leaf --tabs 50000` reported `projectionMs=0`, `treePatchMs=32`, `firstBroadcastMs=152`; `group-live-leaf --tabs 50000` reported `projectionMs=0`, `treePatchMs=26`, `firstBroadcastMs=149`.
- `Current Asymptotics Audit` updated: structural command patching now explicitly includes candidate-backed non-same-parent `moveNode`; sidebar patch handling now documents the cross-parent leaf fast path and the remaining `O(v)` row-discovery gap before it can honestly be called `O(visible-delta + k)`.

### 2026-06-05: Drag/Drop Command Relocation Echo Absorption

- Baseline tag: `20260605-dnd-runtime-echo-absorption`. `pnpm run build` passed. Escalated `pnpm profile:drag-drop -- --runs 5 --tag 20260605-dnd-runtime-echo-absorption --description baseline --append-results` reported `dropMedianMs=3.9`, `dropMaxMs=4.3`, `dragoverP95MaxMs=8.4`, and `status=discard` because one Playwright run failed and dragover p95 exceeded the 8ms guard. `pnpm profile:background-reconciliation -- --runs 5 --tag 20260605-dnd-runtime-echo-absorption --description baseline --append-results --no-export-profile` reported `status=candidate-keep`, primary `move-top-level-live-leaf`, `primaryMedianMs=328`, `eventEchoMaxMs=0`, `runtimeGetWindowsCountMax=0`, `stateSavesMax=1`, `storageSetCallsMax=2`.
- Change: command-owned native relocation echoes from `tabs.onDetached`, `tabs.onAttached`, and `tabs.onMoved` are absorbed when `runtimeFacts.commandRelocatedTabEcho(tabId)` still matches the current live node and command destination. The relocation ledger is not consumed, so stale `tabUpdated`/`tabCreated` filtering still has the same fact available.
- Added focused controller coverage for absorbed detach/attach/move echoes, stale updates after absorption, and the negative browser-authored relocation path. Added a `command-relocation-echo` background reconciliation scenario with absolute guards for `eventEchoMs`, `runtime.getWindows`, state saves, and `storage.local.set` calls.
- Direct sentinel: `pnpm profile:background-reconciliation -- --runs 5 --scenarios command-relocation-echo --tag 20260605-dnd-runtime-echo-absorption --description command-relocation-echo-sentinel --append-results --no-export-profile` reported `status=candidate-keep`, `primaryMedianMs=314`, `eventEchoMaxMs=0`, `runtimeGetWindowsCountMax=0`, `stateSavesMax=1`, `storageSetCallsMax=2`.
- Acceptance wrapper: `pnpm autoresearch:accept --lanes runtime,storage,projection --tag 20260605-dnd-runtime-echo-absorption --description command-relocation-echo-absorption --append-results -- pnpm profile:background-reconciliation -- --runs 5 --scenarios command-relocation-echo --tag 20260605-dnd-runtime-echo-absorption --description command-relocation-echo-absorption --append-results --no-export-profile` reported final `keep` with `perf=candidate-keep` and `correctness=pass`. This used the new scenario's absolute guards rather than a pre-change `--baseline-ms`, because the sentinel did not exist in the baseline build.
- Focused trace IDs passed with zero failures: `po-outliner-relocation`, `rt-stale-created-after-fresh-relocation-event`, `rt-stale-updated-after-fresh-relocation-event`, `rt-stale-activation-after-fresh-relocation-event`, `rt-native-close-after-relocation`, `po-history-browser-move-before-undo`, `po-history-mixed-scope-browser-drift-before-undo`.
- Final sidebar drag/drop run: `pnpm profile:drag-drop -- --runs 5 --tag 20260605-dnd-runtime-echo-absorption --description final --append-results --baseline-ms 3.9` reported `dropMedianMs=3.6`, `dropMaxMs=3.8`, `dropTreePatchMaxMs=3.1`, `dropVirtualRowsMaxMs=0.7`, `dropProjectionBuildCount=0`, `dragoverP95MaxMs=4.6`, `playwrightFailureCount=0`, but `status=discard` because the profiler required a 0.4ms median improvement and observed 0.3ms.
- Residual guard note: `RUNTIME_PERF_GUARD_TAGS=relocation,history pnpm perf:runtime-guard` failed twice, and once outside the sandbox, on the historical `command-group-live-leaf` timing budget (`firstBroadcastMs` 154-171ms over limit 138ms; one run also had `totalMeasuredMs=212` over limit 207). `command-move-leaf` passed each run. No runtime perf budget was moved.

### 2026-06-05: Structural Drag/Drop Save Deferral

- Stacked branch/tag: `codex/dnd-structural-save-deferral`, `20260605-dnd-save-deferral-autoresearch`. Base guard classification on `codex/dnd-runtime-echo-absorption`: `RUNTIME_PERF_GUARD_TAGS=relocation,history pnpm perf:runtime-guard` already failed before this change (`command-group-live-leaf firstBroadcastMs=178 > 138`, `totalMeasuredMs=225 > 207`; `command-move-leaf firstBroadcastMs=233 > 160`).
- Change: command relocation lifecycle journals still write immediately, but they no longer force-drain a pending structural state save before appending another relocation journal. Pure structural runtime-provenance checkpoints now remain on the interaction save schedule when all live runtime resources still exist; delete/restore/native close and other lifecycle-base paths keep their synchronous checkpoint behavior.
- Added delayed-save controller coverage for command-window/root structural moves: ack and tree patch arrive before V3 state persistence, follow-up `focusNode` completes while a delayed state save is in flight, three root moves coalesce to one eventual V3 state save, and an explicit flush remains restart-loadable.
- Added `structural-save-pressure` to the background reconciliation profiler. Direct 5-run profile reported `status=candidate-keep`, `followUpCommandMaxMs=11`, `stateSaveStartedBeforeAckCount=0`, `stateSavesMax=1`, `storageSetCallsMax=2`, `fullStateBroadcastsMax=0`, `runtimeGetWindowsCountMax=0`, `primaryMedianMs=582`, and `saveFlushMaxMs=373` with an injected 250ms V3 storage delay.
- Acceptance wrapper: `pnpm autoresearch:accept --lanes runtime,storage,projection --tag 20260605-dnd-save-deferral-autoresearch --description structural-save-deferral --append-results -- pnpm profile:background-reconciliation -- --runs 5 --scenarios structural-save-pressure --tag 20260605-dnd-save-deferral-autoresearch --description structural-save-deferral --append-results --no-export-profile` reported final `keep` with `perf=candidate-keep` and `correctness=pass`.
- Focused traces passed with zero failures: `po-outliner-relocation`, `rt-stale-created-after-fresh-relocation-event`, `rt-stale-updated-after-fresh-relocation-event`, `rt-native-close-after-relocation`, `po-history-browser-move-before-undo`, `po-history-mixed-scope-browser-drift-before-undo`.
- Final sidebar drag/drop guard: `pnpm profile:drag-drop -- --runs 5 --tag 20260605-dnd-save-deferral-autoresearch --description final --append-results` reported `status=candidate-keep`, `dropMedianMs=3.7`, `dropMaxMs=4.5`, `dropTreePatchMaxMs=3.9`, `dropVirtualRowsMaxMs=1`, `dropProjectionBuildCount=0`, `dragoverP95MaxMs=5.3`, and `playwrightFailureCount=0`.
- Residual guard note after the change: `RUNTIME_PERF_GUARD_TAGS=relocation,history pnpm perf:runtime-guard` still failed on the pre-existing `command-group-live-leaf` timing budget (`firstBroadcastMs=160 > 138`), while `command-move-leaf` passed (`firstBroadcastMs=128`, `totalMeasuredMs=129`). No runtime perf budget was moved.

### 2026-06-05: Existing Command-Window Drag Relocation

- Follow-up manual profile `dist/tabs-outliner-profile-2026-06-05.json` still showed multi-second drag/drop stalls. The expensive spans were no longer sidebar hover: three repeated `moveNode` drops into an existing command-created window each triggered native `tabs.onDetached`/`tabs.onAttached`/`tabs.onUpdated`, `refreshFromRuntime`, `runtime.getWindows`, `nodeStateUpdated`, and a synchronous V3 `storage.local.set` of about 3.4-3.7s for 7-8 keys.
- Root cause: `moveNode(parentId=existingLiveWindow)` successfully moved the browser tab, but the command result kept the moved live tab's old `live.windowId`. That meant `runtimeFacts.recordCommandRelocatedTabs()` did not create a relocation echo ledger entry for repeated drops into an existing command window, so native echoes fell back to full runtime refresh and immediate persistence.
- Change: after a successful targeted `syncMovedSubtreeBrowserOrder()` for `moveNode`, the command result now updates moved live subtree tab `live.windowId` values to the known destination live window. Browser-authored moves, nested live-window moves, and full-sync fallback paths stay on the existing reconciliation path.
- Added focused controller coverage for this real shape: prepare a command-created destination, move another live tab into it with `moveNode(parentId=...)`, emit matching detach/attach/move/update echoes, and assert unchanged state, no `windows.getAll`, no extra storage set, no full broadcast, and absorbed detach/attach/move marks.
- Added `command-existing-window-relocation-echo` to `profile:command` and `profile:background-reconciliation`. Direct 5-run result: `status=candidate-keep`, `primaryMedianMs=311`, `eventEchoMaxMs=18`, `runtimeGetWindowsCountMax=0`, `stateSavesMax=1`, `storageSetCallsMax=1`, `fullStateBroadcastsMax=0`, and `runtimeEventMaxMs=17`.
- Acceptance wrapper: escalated run was required because the sandbox blocked the wrapper-spawned Playwright web server (`PermissionError: [Errno 1] Operation not permitted`); direct first-paint Playwright passed. Escalated `pnpm autoresearch:accept --lanes runtime,storage,projection --tag 20260605-existing-window-relocation-echo --description existing-window-relocation-runtime-placement --append-results -- pnpm profile:background-reconciliation -- --runs 5 --scenarios command-existing-window-relocation-echo --tag 20260605-existing-window-relocation-echo --description existing-window-relocation-runtime-placement --append-results --no-export-profile` reported final `keep` with `perf=candidate-keep` and `correctness=pass`.
- Focused traces passed with zero failures: `po-outliner-relocation`, `rt-stale-created-after-fresh-relocation-event`, `rt-stale-updated-after-fresh-relocation-event`, `rt-native-close-after-relocation`, `po-history-browser-move-before-undo`, `po-history-mixed-scope-browser-drift-before-undo`.
- Residual guard note: `RUNTIME_PERF_GUARD_TAGS=relocation,history pnpm perf:runtime-guard` still fails on the pre-existing `command-group-live-leaf` first-broadcast timing budget (`152 > 138`), while `command-move-leaf` passes (`139ms`). No runtime perf budget was moved.

### 2026-06-03: Restore Transient Echo A/B After Data-Loss Fix

- Checked whether `ccf984c` regressed `restore-last-transient-echo` after the RT-247/RT-248 runtime-order correctness fix. The A/B used detached `/private/tmp` worktrees at baseline `7740671` and fix `ccf984c`, 3 warmups per commit, then 15 alternating measured runs per commit.
- Command: `node scripts/profile-restore.mjs --scenario controller-event-echo --tabs 50000 --target last --echo transient-separated`.
- Result: no meaningful regression by the accepted threshold. Baseline `firstBroadcastMs` median/p90/max was `33/41/44`; `ccf984c` was `33/42/56`, with one fix-side outlier. `commandMs` median improved from `49` to `47`; `totalMeasuredMs` median improved from `51` to `49`; `totalWithSaveFlushMs` median improved from `134` to `131`.
- Interpretation: both commits were already above the guard's `23ms` first-broadcast limit, so the current `restore-last-transient-echo` timing miss is not introduced by the data-loss fix. No runtime perf budget movement accepted, and no code change made from this A/B.

### 2026-06-02: Visible-First Large Imports

- Diagnosed real profile `dist/tabs-outliner-profile-2026-06-02 copy.json`: app-side import append was tiny, but `importTree` waited on an import-only `flushPendingSaves()`, producing `background.state.save` max 44,133ms and `background.runtime.message(importTree)` 44,255ms. Sidebar patch/render/diagnostics were secondary residual costs after the visible tree update.
- Change: `importTree` now follows the structural edit durability model: broadcast the visible patch and acknowledge immediately, then let state/history persistence remain deferred and coalesced. The sidebar success notice now says the tree is saving in the background.
- Added a `profile-command` `import-large` scenario, modeling a large imported window with `--tabs` imported tabs appended to a same-sized live tree.
- After `pnpm build`, `node scripts/profile-command.mjs --scenario import-large --tabs 26460` reported `commandMs` 440ms, `firstBroadcastMs` 322ms, `saveFlushMs` 281ms, `totalWithSaveFlushMs` 721ms, 0 full state broadcasts, 1 tree-structure broadcast, and 1 state save. Synthetic ack latency is under the 2s residual-work gate; any remaining real-browser delay should be checked with a fresh in-browser export before changing bulk import transport.
- Follow-up profile `dist/tabs-outliner-profile-2026-06-02 copy 2.json` showed the import command stayed visible-first (`background.runtime.message(importTree)` 272ms), but deleting the imported subtree while the deferred save was in flight made `deleteNode` wait 10,951ms. The delete patch broadcast landed quickly; the wait came from `flushRuntimeTruthSaveIfPresent()` flushing the unrelated large import save because some live runtime-truth metadata existed elsewhere in the tree.
- Change: `deleteNode` now flushes runtime-truth saves only when the command actually changes runtime provenance, live runtime placement, or removes a live node whose window needs a runtime-truth checkpoint. Deleting a closed imported subtree keeps the visible-first durability model and no longer waits for an unrelated in-flight import save.
- After `pnpm build`, `node scripts/profile-command.mjs --scenario import-large --tabs 26460` still reported `commandMs` 380ms, `firstBroadcastMs` 279ms, `saveFlushMs` 267ms, 0 full state broadcasts, 1 tree-structure broadcast, and 1 state save. Added controller coverage with `storage.local.set` held unresolved: deleting the imported subtree acknowledges before the in-flight import save completes.

### 2026-05-26: Real-Browser Startup Storage Fanout

- The 2026-05-26 exported real startup profile showed a synthetic/real gap: first paint stayed fast, but full sidebar hydration was dominated by Firefox `storage.local` fanout. Baseline before the accepted fix had `primary_ms` 5,314ms, `background.state.load` 3,343ms, `v3.nodeShardRead` 2,000ms for 256 keys, `v3.orderPageRead` 680ms for 7,062 keys, sidebar hydration max 5,314ms, and save max 6,651ms.
- Accepted storage format change: future V3 saves now use 32 node shards instead of 256. Existing manifests with stale shard counts still load, then schedule a full rewrite to the current physical layout so incremental baselines do not mix shard schemes.
- Real browser confirmation from `dist/tabs-outliner-profile-2026-05-26 copy 3.json`: `primary_ms` improved to 2,531ms, `background.state.load` 1,897ms, `v3.nodeShardRead` 1,331ms for 32 keys, `v3.orderPageRead` 510ms for 7,062 keys, sidebar hydration max 2,531ms, and save max 1,102ms.
- Follow-up bounded shard-count candidates were discarded: 16 shards measured 595ms synthetic real-mimic primary versus the 633ms comparison point, only 38ms better where 50ms was required; 8 shards measured 604ms, worse than 16 and also below the threshold. Both experiments were reverted, leaving 32 shards as the accepted format.
- Correctness note from the same investigation: the sidebar now tracks whether `currentState` has a full node table before enabling export/search/import/drag/drop and most row actions. This preserves the 256-row sparse first-paint target while preventing partial sidebar-local state from being exported as a complete tree.
- Theoretical optimum assessment after correctness hardening: first paint, hover, and scroll-away optimums are unchanged because they are intentionally defined on bounded sparse snapshots and sparse row-window fetches. The full-tree-ready optimum did change: any feature that needs a complete local `OutlineState` now has a real lower bound of full background load plus full-state transport/render in each hydrating sidebar. Getting back to the old "everything feels loaded" speed requires either making more features work authoritatively from sparse/background-backed state or changing storage/transport so full hydration is no longer whole-tree fanout per sidebar.
- Remaining target: real full hydration still reads all node shards and about 7,062 order-page keys for the order-page-heavy shape. The next startup-storage loop should focus on reducing order-page read fanout or making full-tree feature unlock lazier, not simply retrying smaller node shard counts.
- Verification for the accepted state included `pnpm test`, `pnpm run build`, `pnpm profile:sidebar-startup -- --shape real-browser-20260526 --runs 5`, `pnpm perf:sidebar-projection-guard`, and `pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --reporter=list`.

### 2026-05-25: Sidebar Projection Perf Guard

- Added `pnpm perf:sidebar-projection-guard` as the hard gate for sidebar projection/hydration fix passes. It wraps the startup hover and sparse scroll-away profile loops, treats `guardFailures` or `status: discard` as command failures, and allows one confirmation retry for browser timing noise.
- Kept the profile loops as autoresearch tools: they still emit JSON/TSV summaries without becoming hard gates by themselves.
- While making the guard hard, it exposed an existing sparse scroll-away slip: scroll events were synchronously re-rendering sparse projection rows even when the viewport needed no DOM update. Skipping that scroll-path render for sparse projections restored the smoke guard from `scrollDelayMaxMs=11.1` to `0.3`, with rows still visible within `4.7ms`.
- Verification: `pnpm perf:sidebar-projection-guard -- --smoke` passed after `pnpm build`.

### 2026-05-24: Runtime Lifecycle Perf Recovery

- Recovered the lifecycle-journal performance regression while keeping the crash-recovery correctness work intact.
- Split synthetic profile accounting so full state saves are tracked separately from tiny lifecycle-journal writes, and state/tree broadcasts are tracked separately from small `historyStatus` broadcasts. This keeps the guard strict about expensive work without marking required durability/status messages as full-tree regressions.
- Removed avoidable O(total nodes) work from hot paths:
  - command ledger tombstone cleanup now uses command candidate node IDs instead of scanning all live nodes;
  - structural command history deltas reuse command candidate node IDs instead of full-tree undo/redo diffs;
  - live-tab grouping no longer builds a full outline lookup to rediscover the active tab it already visited;
  - source-window-empty checks after relocation now early-exit on the first remaining live tab;
  - v3 manifest save no longer constructs every node shard just to list shard keys;
  - save diffing accepts candidate node IDs from compact patch paths.
- Deferred persisted-baseline cloning after saves, with synthetic profiles explicitly settling setup work before measuring interactions.
- Accepted one small restore budget movement: `restore-last-transient-echo` `firstBroadcastMs` budget moved from 15ms to 20ms because durable restore-create journaling must complete before the browser create side effect. No full state save, state broadcast, projection, or query budget moved.
- Final guard after `pnpm perf:runtime-guard`:
  - close tabRemoved->session: first 49ms, measured 51ms, save-flush-inclusive 185ms, 1 state save, 1 journal write, 1 state broadcast.
  - close session->tabRemoved: first 52ms, measured 54ms, save-flush-inclusive 203ms, 1 state save, 1 journal write, 1 state broadcast.
  - restore transient echo: first 19ms, measured 23ms, save-flush-inclusive 172ms, 1 state save, 1 journal write, 1 state broadcast.
  - delete last tab: first 16ms, measured 17ms, save-flush-inclusive 121ms, 1 state save, 1 journal write, 1 state broadcast, 1 status broadcast.
  - focus last tab: first/measured 16ms, no saves.
  - group live leaf: first 97ms, measured 122ms, save-flush-inclusive 238ms, 1 state save, 1 journal write, 1 state broadcast, 1 status broadcast.
  - move leaf: first 41ms, measured 78ms, save-flush-inclusive 199ms, 1 state save, 1 state broadcast, 1 status broadcast.
  - refresh no-op: measured 77ms, no saves or broadcasts.
- Verification: `pnpm test`, `pnpm build` through `pnpm perf:runtime-guard`, `node --check scripts/hunt-runtime-traces.mjs`, and `pnpm perf:runtime-guard` passed.

### 2026-05-24: Runtime Hunt Perf Guardrails

- Added a budgeted `pnpm perf:runtime-guard` process for correctness fix passes. It checks perceived latency and deferred work: first patch/broadcast time, measured command/event time, save-flush-inclusive time, save/broadcast counts, projection work, runtime query work, and stringified MB.
- Added `scripts/analyze-profile-export.mjs` for real in-browser `tabsOutlinerProfile` exports. It is diagnostic tooling for fresh current-build profiles; historical exports such as `dist/tabs-outliner-profile-2026-05-24.json` are useful context but must not be treated as acceptance evidence for later fixes.
- The guard uses accepted historical budgets from the performant close/restore/delete/focus/command profiles. Current degraded lifecycle paths are expected to fail full-size budgets until repaired; smoke budgets exist only to verify the guard wiring cheaply.

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

### 2026-05-22: Cross-Sidebar Startup Interaction Deferral

- Follow-up profile `dist/tabs-outliner-profile-2026-05-22 copy 7.json` showed the active hover path was healthy: `sidebar.input.pointerDelay` max 1ms, `sidebar.input.hoverFeedbackDelay` max 1ms, `sidebar.input.hoverFrameDelay` p95 14ms / max 19ms, and `sidebar.hoverGuide` max 2ms.
- The remaining brief startup stalls lined up with sibling sidebar contexts, not the hovered sidebar. While the active sidebar deferred its own hydration until after the pointer window, other sidebars still finished sparse startup hydration and rendered full projections during the active pointer window: three `sidebar.render` spans were 41-49ms, and diagnostics added 46-52ms spans nearby. A later diagnostics refresh reached 108ms.
- Change: startup non-edit interactions are now broadcast through the background to all connected sidebar ports, throttled to one message every 500ms while the sender is hydrating. Receiving sidebars treat the message like local non-edit input, so pending sparse full hydration is delayed by the existing 1000ms idle rule across sidebar contexts.
- Change: the diagnostics scheduler now accepts an idle deferral hook. Sidebar diagnostics wait until 1500ms after the last local or cross-sidebar non-edit interaction before running, and record `sidebar.diagnostics.defer` when this postpones advisory work.
- Deterministic guard: the new `pnpm profile:startup-hover` remote-interaction case reported `remoteInteractionAt` about 265ms, `hydrationRequestsBeforeIdle: 0`, and first hydration at about 1267ms, proving sibling hydration no longer fires at the original 750ms timer during startup interaction. The sparse hover guard still reported `sidebar.input.hoverFrameDelay` max 1.5ms and `sidebar.input.hoverFeedbackDelay` max 0.2ms.
- Verification: `pnpm exec vitest run src/sidebar/diagnostics-scheduler.test.ts src/background/controller.test.ts -t "diagnostics|sidebar non-edit interaction"`, `pnpm profile:startup-hover`, and `pnpm run build` passed.

### 2026-05-22: Sparse Startup First-Paint Margin

- Follow-up profile `dist/tabs-outliner-profile-2026-05-22 copy 8.json` showed the active row-hover path was no longer the bottleneck: `sidebar.input.pointerDelay` max 1ms, `sidebar.input.hoverFeedbackDelay` max 1ms, `sidebar.hoverGuide` max 2ms, and `sidebar.input.hoverFrameDelay` p95 18ms / max 22ms. The only real >20ms overlap inside the active pointer window was a late sibling sidebar's `sidebar.render.initialSnapshot` at 52ms.
- Added a first-paint budget case to `pnpm profile:startup-hover`, with tracing enabled before module load. Baseline before the change: sparse hydrating first paint rendered 256 rows plus 1,280 inert action buttons, and `sidebar.render.initialSnapshot` was 27.7ms in Playwright.
- Added `pnpm profile:startup-hover-loop` as the repeated autoresearch loop for this path. It runs the Playwright startup-interaction profile repeatedly, summarizes first-paint render duration, sparse hover frame/feedback delays, hydration deferral, and remote sibling deferral, and can append TSV rows to `autoresearch/sidebar-startup-hover/results.tsv`.
- Change: sparse hydrating first paint now renders only the row label/twisty surface. Edit/action buttons are omitted until full hydration, matching the existing command guard that already blocks those actions during startup hydration.
- Single-run result after the change: `sidebar.render.initialSnapshot` moved to 6.8ms with 0 action buttons. Five-run loop result: status `keep`, first-paint median 5.6ms / max 6.3ms, sparse hover frame max 6.7ms, hover feedback max 0.3ms, `hydrationBeforeIdleMax` 0, and remote sibling hydration delay minimum 1002ms.
- Verification: `pnpm profile:startup-hover-loop -- --runs 5 --tag 20260522-hover --description "omit sparse startup action buttons" --append-results`, `pnpm run build`, and `pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --grep "paints an active-centered sparse snapshot"` passed.

### 2026-05-26: Sparse Startup Does Not Auto-Hydrate

- The remote-projection rewrite moved export, import, search/projection, rename, and restore preflight paths away from sidebar-local full-tree ownership. With those correctness guards in place, valid sparse startup snapshots no longer schedule the old delayed full `getState` hydration.
- Full `getState` remains a fallback when the initial sparse snapshot is unusable. Normal sparse startup stays background-backed and loads additional row windows or command preflight data on demand.
- Updated `pnpm profile:startup-hover-loop` to guard sparse idle behavior instead of hydration deferral. The loop now reports `startup-hover-sparse-idle` and `startup-remote-interaction-sparse-idle`, with both expected to keep `hydrationRequestsAfterIdle` at `0`.
- Updated `pnpm profile:sidebar-startup` so `startup-initial-snapshot` and `real-browser-20260526` no longer synthesize default sidebar `getState` hydration. `hydrateMs` / real-mimic getState medians are expected to be `0` unless an explicit fallback or storage diagnostic path is being measured.
- Verification: `pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --grep "exports and imports|does not auto-hydrate" --reporter=list` and `pnpm exec playwright test tests/playwright/sidebar-startup-interaction-profile.spec.ts --reporter=list` passed.

### 2026-05-22: Startup Scroll-Away Autoresearch Setup

- Added the `pnpm profile:startup-scroll-away` autoresearch loop for scrolling away from the sparse startup projection while the sidebar remains sparse. The Playwright profile starts with an active-centered sparse snapshot around row 40000, keeps `getState` unresolved, scrolls to row 10000, waits two animation frames, and emits `startup-scroll-away`.
- Stop conditions for a future accepted implementation are: no full hydration request, at least 80% viewport row coverage, zero missing viewport rows, rows visible within 32ms, and scroll input queue delay below 8ms.
- Baseline after `pnpm run build`: `pnpm profile:startup-scroll-away -- --runs 5 --tag 20260522-scroll-away --description "baseline" --append-results` reported status `discard`. It confirmed the gap: expected viewport rows median 27, visible rows median/min 0, missing viewport rows max 27, hydration requests max 0, and scroll delay max 0.2ms. No row appeared within the two-frame window, so `rowsVisibleMsMax` was empty.
- This is now a good red target for sparse row-window paging: the interaction itself is cheap, but viewport coverage outside the initial projection is absent until full hydration.
- Verification: `pnpm profile:startup-scroll-away -- --runs 5 --tag 20260522-scroll-away --description "baseline" --append-results` and `pnpm run build` passed.

### 2026-05-22: Sparse Startup Scroll-Away Row Window

- Change: the background now accepts `getInitialTreeSnapshotWindow` for a bounded 256-row sparse snapshot centered on an arbitrary visible row. The sidebar detects sparse-startup scrolls outside the current projection, requests the viewport-centered row window, and applies it without scrolling back to the active tab or requesting full `getState`.
- The sparse window render is delayed to the next animation frame after the response. The first attempt rendered immediately and filled the viewport, but one run reported `scrollDelayMaxMs` 8.1ms, just over the 8ms guard. Deferring the render kept rows under the 32ms visibility budget while restoring scroll input margin.
- Accepted five-run result: `pnpm profile:startup-scroll-away -- --runs 5 --tag 20260522-scroll-away --description "single sparse scroll window request" --append-results` reported status `keep`, visible rows median/min 27 of 27, missing viewport rows max 0, rows visible max 12ms, hydration requests max 0, scroll delay max 2.3ms, and one sparse-window request per run.
- Regression guard: `pnpm profile:startup-hover-loop -- --runs 5 --tag 20260522-scroll-away-hover-guard --description "sparse scroll window hover guard" --append-results` stayed `keep`, with first-paint max 6.6ms, sparse hover frame max 1.5ms, sparse hover feedback max 0.3ms, no hydration before idle, and remote sibling hydration delay minimum 1001.6ms.
- Verification: `pnpm run build`, `pnpm exec vitest run src/background/storage-v2.test.ts`, `pnpm profile:startup-scroll-away -- --runs 5 --tag 20260522-scroll-away --description "single sparse scroll window request" --append-results`, and `pnpm profile:startup-hover-loop -- --runs 5 --tag 20260522-scroll-away-hover-guard --description "sparse scroll window hover guard" --append-results` passed.

### 2026-05-22: Startup Scroll-Away Loop Continuation

- Corrected the autoresearch interpretation: `keep` means a candidate is viable, not that the loop is done. The scroll-away loop now also checks a 32-row follow-on scroll inside the sparse overscan buffer, requiring zero missing rows and zero extra sparse-window requests.
- Accepted refinement: scroll-away windows now request only the viewport plus virtual overscan (`92` rows in the deterministic 27-row viewport) and render immediately. This preserved the 32-row follow-on buffer while avoiding the previous 256-row sparse-window DOM work.
- Accepted five-run result: `pnpm profile:startup-scroll-away -- --runs 5 --tag 20260522-scroll-away --description "32 row overscan follow-on scoped delay" --append-results` reported status `keep`, visible rows median/min 27 of 27, missing rows max 0, rows visible max 3.6ms, follow-on missing rows max 0, follow-on sparse-window requests max 0, hydration requests max 0, and scroll delay max 3.5ms.
- Discarded experiment: reducing sparse scroll overscan to 16 rows looked slightly faster on the first jump, but the expanded follow-on guard reported status `discard` because it needed another sparse-window request and pushed scroll delay to 9ms.
- Regression guard: `pnpm profile:startup-hover-loop -- --runs 5 --tag 20260522-scroll-away-hover-guard --description "inclusive sparse scroll window hover guard" --append-results` stayed `keep`, with first-paint max 6.8ms, sparse hover frame max 4.8ms, sparse hover feedback max 0.4ms, no hydration before idle, and remote sibling hydration delay minimum 1001.3ms.
- Stop reason: after the accepted refinement and the 16-row discard, the remaining plausible next step is adjacent-window prefetch or multi-window sparse projection merging. That is higher-complexity and needs a separate target; the current first-jump plus 32-row follow-on target is already under 4ms with no full hydration and no follow-on request.
- Verification: `pnpm run build`, `pnpm exec vitest run src/background/storage-v2.test.ts`, `pnpm profile:startup-scroll-away -- --runs 5 --tag 20260522-scroll-away --description "32 row overscan follow-on scoped delay" --append-results`, and `pnpm profile:startup-hover-loop -- --runs 5 --tag 20260522-scroll-away-hover-guard --description "inclusive sparse scroll window hover guard" --append-results` passed.

### 2026-05-23: Delete First-Command History Warmup

- Follow-up profile `dist/tabs-outliner-profile-2026-05-23.json` showed small delete latency was dominated by first-command setup, not delete scaling: the first small `deleteNode` spent 32ms in `background.runtime.message` while `background.command.run` was only 2ms; a later warmed small `deleteNode` in the same profile took 5ms total.
- Change: requesting the initial sidebar tree snapshot now schedules an undo-history warmup on the next macrotask. The warmup reuses a shared in-flight history load, so the first structural command no longer pays the `outlineHistory` storage read when the user interacts after startup.
- Added `scripts/profile-delete.mjs --warm-history --history-read-delay-ms N` to make this fixed cost measurable. With a synthetic 25ms history read on a 100-tab middle delete, cold command latency was 28ms; after the startup warmup path, command latency was 2ms and first broadcast was 2ms.
- Verification: `pnpm exec vitest run src/background/controller.test.ts -t "initial tree snapshot|warms undo history"`, `pnpm build`, `node scripts/profile-delete.mjs --tabs 100 --target middle --count 1 --shape wide --history-read-delay-ms 25`, and `node scripts/profile-delete.mjs --tabs 100 --target middle --count 1 --shape wide --history-read-delay-ms 25 --warm-history` passed.

### 2026-05-25: Runtime Window Scope Routing Guard

- Perf blast radius for the RT-187/RT-190 fix was runtime event routing, restore, native close, delete, and refresh. The first implementation rebuilt runtime scopes on no-op refresh and compact command/event patch paths; `pnpm perf:runtime-guard` caught regressions in close, restore, group-live-leaf, and refresh-noop.
- Accepted shape: scope reconstruction stays on startup/full runtime rebuild paths, while compact paths rely on existing runtime tombstones and command facts. Closed scoped/tombstoned rows still get durable delete journaling without a full node-table scope rebuild.
- Final `pnpm perf:runtime-guard` passed: close first broadcast 44-47ms, restore first broadcast 18ms, delete first broadcast 15ms, group-live-leaf first broadcast 100ms, move-leaf first broadcast 39ms, and refresh-noop total 98ms. Counters stayed at accepted budgets: no extra saves, broadcasts, full projections, or storage stringify budget movement.

### 2026-05-31: Runtime Truth Perf Guard Cleanup

- Baseline on `codex/runtime-perf-guard-fix` failed timing-only budgets: close first broadcast 291-293ms, restore 82ms, delete 241ms, group-live-leaf 323ms, move-leaf 265ms, and refresh-noop total 401ms. Hard counters were already clean, so the issue was interaction-path CPU rather than extra browser queries, saves, or broadcasts.
- CPU/profile traces pointed at full runtime scope and installed-state shape rebuilds on compact paths, plus no-op refresh rebuilding scopes after a material match. The fix keeps full rebuilds for restart/replay/whole-snapshot paths, but uses cheap scope/snapshot comparison, tombstone-owned removal skips, and touched-window scope updates for candidate-node command/event transitions.
- Final `pnpm perf:runtime-guard` passed: close first broadcast 46-47ms, restore 19ms, delete 23ms, group-live-leaf 119ms, move-leaf 91ms, and refresh-noop total 115ms. Counters stayed within budget: no added saves, projections, runtime queries, storage calls, or status/state broadcast count changes.

### 2026-06-11: Restore First-Broadcast Guard Recovery

- `pnpm perf:runtime-guard` was red on `restore-last-transient-echo` (`firstBroadcastMs`
  28-39 vs limit 23) and flaky on `command-group-live-leaf` (up to 144 vs limit 138). A
  167-commit bisect isolated the regression to `91f1a63` (preserve raced tab metadata):
  `updateWindowScopesFromStateTransition` computed `candidateLiveTabNodesAffectingRuntimeOrder`
  eagerly per affected window, and that helper ends with a whole-window outline-order walk
  (~10-13ms on the 50k-tab guard tree). In the restore path the result was discarded unread
  (the `runtimeWindow` branch wins); in the group path it was read only to test emptiness.
- Change: the order-candidates list is now computed lazily at the two consuming branches,
  and the helper returns `[]` before the walk when no candidate affects runtime order. Both
  are evaluation-order-only changes; the raced-metadata regression test (seed 422754531)
  and the full suite stay green.
- Result: restore first broadcast 20-25ms (median 22, was 28-39); group-live-leaf 123-133ms
  (was up to 144). Full guard PASS across all 9 scenarios with unchanged hard counters.
- Accepted budget movement: restore `firstBroadcastMs` 20 -> 22. The post-fix median
  reflects ~2ms of real v4-era pre-broadcast work on the restore ack (restore-recovery
  before-snapshot, lifecycle durable-base check, candidate-shard save scheduling) that the
  v4 branch never re-baselined; the pre-91f1a63 calibration measured 19-23 on the same
  machine.
- Verification: `pnpm build`, `pnpm exec vitest run`, `pnpm perf:runtime-guard`, regression
  trace corpus (`RUNTIME_TRACE_HUNT_PROFILE=regression pnpm trace-hunt:runtime`) all green.

### 2026-06-11: Dogfooding fixes - stale boot snapshot + undo durability

- Dogfooding (delete + immediate browser restart) surfaced two holes: the sidebar painted
  a pre-delete tree from the storage-served boot snapshot and never converged until an
  unrelated event, and the delete's undo entry (riding the 5-30s interaction save) was
  lost while its state delta survived via the journal.
- Sidebar: storage-served initial snapshots are now flagged `fromStorage`; on applying one
  the sidebar schedules the existing deferred full hydration (750ms) unconditionally.
  Live-served sparse snapshots keep the lazy hydrate-on-demand contract, so the 50k-node
  first-paint path gains no eager state transfer (guarded by "does not auto-hydrate after
  sparse first paint"). Cost: one deferred `getState` per sidebar boot only during the
  background-still-loading race.
- Journal: command entries now carry `historyEntryId` (~40 bytes per history-tracked
  command entry; same write count). Startup replay rebuilds missing undo entries from the
  journal fold (`replayJournalWithHistory`) with id-based dedup against the loaded
  history; the fold's per-entry node-table copy runs only on the crash-recovery path.
  The recovered-delete error path now journals its delta like the success path.
- Verification: `pnpm build`, full vitest (723), full playwright (279), and
  `perf-runtime-guard --hard-only` PASS across all 9 scenarios with unchanged budgets
  (mbStringified unmoved; delete-last-tab journalWrites still 1).

### 2026-06-11: Simplification series - dead legacy write pipeline out of prod, shared helpers, profile-seed fidelity

- Refactor-only series on `refactor/simplify` (5 commits): compiler-verified dead code
  removal; one canonical `isLiveTabNode`/`isLiveWindowNode`/`liveTabNodes`/
  `liveWindowNodes` + `cloneOutlineNode`/`cloneOutlineState` in `src/model/` replacing six
  per-file copies; the dead v2/v3 *write* pipeline (~450 lines: `saveStateAndHistory`,
  `outlineStateV3Changes`, incremental shard/order-page diffing, candidate promotion, save
  phases) deleted from `storage.ts` with full-save fixture writers moved to
  `storage-legacy-write.test-support.ts` (excluded from the shipped build; v2/v3 read/
  migration ladder untouched); controller native-close + command-ack tail dedup; sidebar
  hover-guide cleanup extraction. No algorithmic shape, transport shape, or save timing
  change anywhere - the Current Asymptotics Audit table is unchanged.
- Profile-harness fidelity finding: `profile-restore`/`profile-tab-open` previously seeded
  fake storage with a v3 store, so every guarded run measured a one-time migration boot
  rather than the steady-state v4 load; worse, handing the harness's in-memory model
  objects directly to `loadStateV4` distorts hot model paths downstream (restore-last
  `firstBroadcastMs` read 26-32ms). Seeds are now
  `JSON.parse(JSON.stringify(outlineStateV4Snapshot(...).setItems))` - the round-trip
  mimics the structured-clone shapes real `storage.local` returns and restored the
  scenario to 18-22ms (pre-change v3-seed baseline: 20-21ms). Rule of thumb: fake-storage
  seeds must cross a serialization boundary or hidden-class artifacts leak into measured
  windows.
- Verification: `pnpm check` green (oracle + vitest 714 passed | 2 skipped + build; the
  nine deleted tests asserted dead v3 incremental-write behavior), `pnpm
  perf:runtime-guard` PASS (9 scenarios, hard counters identical throughout the series),
  `pnpm perf:sidebar-projection-guard` PASS (sparseHoverFrameMaxMs 6.3-6.8 across repeat
  runs; one 8.3 outlier on a loaded machine prompted the reruns).

### 2026-06-12: Round 2 - v2 removal, test type-checking, projector extraction

- `feat(storage)!`: the v2 read/migration path is gone (user-approved). v2-only stores now
  bootstrap with keys retained plus a `bootstrapSkippedStoredDataPresent` incident; the v3
  ladder (R3) is unchanged. `loadInitialTreeSnapshot` reads one fewer key.
- Test files are now actually type-checked (`pnpm check` runs `typecheck:test`): the old
  tsconfig.test.json inherited the base exclude, so test/test-support files were never
  checked and ~90 strictness errors had accumulated, including assertions that passed
  vacuously (`loadStateV2` read-backs of a v4 store). Splitting the 1,109-entry runtime
  domain trace table past tsc's TS2590 union limit re-enabled per-entry checking and
  exposed one trace whose `nativeCloseWindow` order `"sessionChangedOnly"` was silently
  running as `tabsRemovedOnly`; the fake runtime now implements the sessions-only window
  close and the trace passes as authored.
- `initial-tree-snapshot.ts` now owns the sparse first-paint projector (~500 lines moved
  out of storage.ts; pure relocation). storage.ts is 623 lines of load/migration logic
  (1,711 at branch start). No algorithmic, transport, or save-timing change in either
  round - the Current Asymptotics Audit table is unchanged.
- Verification: vitest 712 passed | 2 skipped; tsc clean on build and test configs;
  `pnpm perf:runtime-guard` PASS (9 scenarios) and `pnpm perf:sidebar-projection-guard`
  PASS (2 scenarios) after the extraction, hard counters unchanged throughout.
