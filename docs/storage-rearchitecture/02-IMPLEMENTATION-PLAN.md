# Implementation Plan

Audience: an implementer who has read [00-DIAGNOSIS.md](./00-DIAGNOSIS.md) and
[01-TARGET-ARCHITECTURE.md](./01-TARGET-ARCHITECTURE.md) but nothing else. Follow
phases in order. Phase 0 steps are independent of each other and of Phases 1–4;
land each as its own commit. Phases 1–4 build on each other.

Conventions for every step:

- **Red first.** Write the named failing test, watch it fail
  (`pnpm exec vitest run <file> -t "<name>"`), then implement, then watch it pass.
- **Gates per commit**: `pnpm test` green; `pnpm perf:runtime-guard` not worse than
  before your change (after Phase 0 it must be fully green and stay green);
  if you touched `src/sidebar/**`: `pnpm perf:sidebar-projection-guard`.
- **Budget edits** to `scripts/runtime-perf-budgets.json` are allowed only where a
  step explicitly says so.
- **Record perf-relevant changes** in `PERFORMANCE_NOTES.md` (scenario, command,
  before/after numbers) per `AGENTS.md`, including for correctness steps — every step
  here is perf-relevant by definition.
- Do not modify the PureScript oracle in any step of this plan.

---

## Phase 0 — Stop the bleeding (no architecture change)

Restores the perf guard to green and closes loss vectors V1/V2 from the diagnosis.

### P0.1 Incident log: anomalies only, no extra storage round-trips

Problem: `recordIncidentLog("saveFlush", …)` runs on **every** save flush
([controller.ts:5097–5099](../../src/background/controller.ts)) and each append does a
`storage.local.get` + `set` ([incident-log.ts:41–65](../../src/background/incident-log.ts)).
This is the `saves: 2 > 1` guard failure and buries real anomalies in noise.

Steps:

1. Test (`src/background/controller.test.ts`): "does not write an incident log entry
   for a routine save flush" — drive one small mutation through a controller with a
   mocked api, flush saves, assert no `tabsOutlinerIncidentLog:v1` key was written.
2. Test: "writes an incident log entry when a save flush sharply reduces closed or
   total node count" — construct a flush where `closedCountDelta <= -25` or
   `nodeCountDelta <= -50` (thresholds as constants), assert one entry with event
   `saveFlushAnomaly` and the existing count-delta detail.
3. Implement in `saveStateAndHistoryNowWithTrace`
   ([controller.ts:5071–5106](../../src/background/controller.ts)): compute the count
   details as today, but call `recordIncidentLog` only when the anomaly predicate
   holds. Name the constants `SAVE_FLUSH_ANOMALY_CLOSED_DELTA = -25`,
   `SAVE_FLUSH_ANOMALY_NODE_DELTA = -50` next to the other save constants
   (controller.ts:339).
4. In-memory incident cache: change `incident-log.ts` so the module loads the stored
   log once (lazily) into memory and `appendIncidentLogEntry` writes
   `[...cachedEntries, entry].slice(-limit)` with a single `set` (no `get` per append).
   Keep the existing `appendQueue` serialization. Add a unit test in
   `incident-log.test.ts`: "appends without re-reading storage after the first append"
   (count `get` calls on the mock).
5. Keep all other incident events (startup, lifecycle recovery, structure repair,
   guard restore, backups) — they are rare by construction.
6. Update the two Playwright options-page assertions if they relied on `saveFlush`
   entries appearing (`tests/playwright/options-page.spec.ts`).

Acceptance: `pnpm perf:runtime-guard` — `saves` budget failures for
close/restore/delete/group/move scenarios are gone.

### P0.2 Take checkpoint flushes off the ack path; journal provenance cheaply

Problem: `flushRuntimeProvenanceSaveIfChanged` / `flushRuntimeTruthSaveIfNeeded` /
`flushRuntimeTruthFastPathSaveIfNeeded` await `flushPendingSaves()` before
`commandAck`/event completion ([controller.ts:1065–1165, 3426, 3498, 4339–4388]),
violating the ack contract (REMOTE_PROJECTION_REWRITE.md non-goal, line 19).

The durability these flushes provide is: runtime provenance/placement must survive a
crash so startup classification doesn't mangle closed subtrees. Provide that with a
small write instead of a full flush:

1. Extend `runtime-lifecycle-journal.ts` with a new bounded entry kind
   `runtimeTruthHint`: `{ kind: "runtimeTruthHint", windows: Array<{ nodeId, windowId,
   provenance, liveTabIds?: number[] }> }` — only the windows whose
   provenance/placement changed in this transition (derive from the same
   `candidateNodeIds` the flush predicates already receive). Cap: if the hint would
   exceed 64 windows, fall back to awaiting `flushPendingSaves()` as today (rare).
2. Startup already consumes the lifecycle journal against a complete runtime snapshot
   (`recoverRuntimeLifecycleJournal`, controller.ts:2036…). Teach it to apply
   `runtimeTruthHint` entries: for each hinted window node that exists in the loaded
   state, set its `runtimeProvenance` (and live ref if the snapshot confirms the
   window/tabs exist) before reconciliation — mirroring what
   `alignKnownRuntimeWindowProvenance` would have produced had the save flushed.
   Clear hints after the first post-recovery save like other entries.
3. Replace the bodies of the three `flushRuntimeTruth*`/`flushRuntimeProvenance*`
   functions: when the predicate fires, append the journal hint (awaited — it is one
   small `set`, already counted as `journalWrites` by the harness) and leave the real
   save on its existing deferred schedule. Delete the `await flushPendingSaves()`
   calls from these paths only (explicit `flushPendingSaves()` for tests/shutdown
   stays).
4. Tests, red first, in `controller.test.ts`:
   - "restore command acks without flushing pending state saves" (mock storage
     records set timestamps; assert ack resolves before any v3 manifest write; assert
     a lifecycle-journal write happened).
   - "startup applies runtimeTruthHint provenance before reconciliation" — simulate:
     state saved without provenance, hint journaled, restart with matching runtime
     snapshot → window keeps `browserCreated`/`restored` provenance and closed
     subtrees survive (reuse the closed-subtree startup fixtures from the
     `72bc680` tests).
   - Keep/adapt the existing checkpoint tests: they currently assert a flush; change
     them to assert hint-append + deferred save.
5. Budget edits (explicit): in `scripts/runtime-perf-budgets.json`, scenarios
   `close-last-tab-removed-then-session`, `close-last-session-then-tab-removed`,
   `restore-last-transient-echo`, `delete-last-tab`, `command-move-leaf`,
   `command-group-live-leaf`: `journalWrites` may rise by at most 1; `saves` stays at
   its original value (1); `totalWithSaveFlushMs` must not increase (expect it to
   drop). Record before/after in PERFORMANCE_NOTES.md.

Acceptance: `pnpm perf:runtime-guard` fully green, including the timing budgets
(restore ≤23 ms, group ≤138 ms — the forced flush work was on those paths).
`pnpm test` green (expect to update only tests that asserted the old flush behavior).

### P0.3 Save failures: retry, then force a full save

Problem: a failed flush drops the pending snapshot and never retries; a partially
applied flush silently poisons the incremental baseline (V2, RC-4).

1. Tests (`controller.test.ts`), red first:
   - "re-schedules and retries after a failed state save": mock `storage.local.set`
     to reject once then succeed; flush; assert a second flush happens (timer-driven,
     use fake timers), assert the eventual storage content equals the state, and
     assert an incident `stateSaveFailed` with the error message.
   - "forces a full-diff save after a save failure": after the failed attempt, assert
     the retry's `outlineStateV3Changes` ran without `previousState` (observable via
     the save-phase trace detail `fullSave: true`, already emitted —
     [storage.ts:334–351](../../src/background/storage.ts)).
2. Implement in `saveStateAndHistoryNowWithTrace` / `flushScheduledSave`
   ([controller.ts:5001–5131](../../src/background/controller.ts)):
   on save rejection — set `lastPersistedState = undefined` (forces full save, the
   only state guaranteed consistent with an unknown partial write), restore
   `pendingSaveState`/`pendingSaveHistory` if nothing newer arrived, set
   `pendingSaveRequiresFullDiff = true`, `recordIncidentLog("stateSaveFailed", …)`,
   and re-arm the save timer with backoff (1 s, then 4 s, then 16 s; reset on
   success). Keep swallowing the error (don't crash the event handler).

### P0.4 Kill the silent stale fallback at load (loss vector V1)

Problem: v3 load failure silently loads the frozen v2 manifest or returns `undefined`
→ bootstrap ([storage.ts:259–287], [controller.ts:1982–1984]).

1. Change `loadStateWithMetadata` so the v3 branch distinguishes three outcomes:
   - v3 manifest absent → proceed to v2 (legitimate: pre-migration profile);
   - v3 loads (possibly with repair) → return as today;
   - v3 manifest **present but load failed** → return a new result
     `{ failure: "v3LoadFailed" }` instead of falling through to v2.
   Type: extend `LoadedOutlineState` or add a union member; keep `loadState()`
   compatibility (it can keep returning `undefined` for both absent and failed —
   only the controller path needs the distinction).
2. Salvage instead of fallback: when the manifest is present but shards/pages fail
   their checks, attempt best-effort materialization — keep nodes from every shard
   that parses; attach whatever order pages exist; for nodes whose pages are
   missing/mismatched, accept the partial `childIds` (or empty) — then run
   `normalizeLoadedV3Structure` (it already drops dangling refs and re-roots
   unreachable nodes) and return the result flagged `requiresFullSave: true` plus a
   `salvaged: true` marker. Only if *zero* shards parse does the controller consider
   v2.
3. Controller startup ([controller.ts:~1950](../../src/background/controller.ts)):
   - on `salvaged` → `recordIncidentLog("v3LoadSalvaged", {…repair counts})`,
     schedule an immediate full save, continue;
   - on total v3 failure with a v2 manifest present → load v2 but record incident
     `staleV2FallbackUsed` **and** surface it: reuse the diagnostics surface the
     options page reads (the incident log viewer added in `369c317`) — no new UI
     needed, but the incident must exist;
   - `bootstrapFromWindows` only when no v3 *and* no v2 *and* no v1 keys exist;
     otherwise prefer salvage output even if tiny, and record
     `bootstrapSkippedStoredDataPresent` if it would have bootstrapped.
4. Tests, red first, in `storage-v2.test.ts`:
   - "salvages v3 when an order page is missing instead of failing the load"
     (write a valid store, delete one order page key, load → state contains the
     parent with its remaining children, `requiresFullSave`, repair counts reported);
   - "salvages v3 when a shard is corrupt" (overwrite one shard with garbage →
     remaining shards' nodes survive);
   - "does not fall back to v2 when a v3 manifest exists" (valid stale v2 + corrupt
     v3 → result is salvaged v3, not v2 state).
   And in `controller.test.ts`: "startup never bootstraps over stored data" —
   corrupt v3 everything + no v2 → controller state contains salvage output (even
   empty-rooted), incident recorded, full save scheduled; assert
   `bootstrapFromWindows` result shape was NOT installed (no live-window-only tree
   when the salvage had closed nodes).

### P0.5 Stop rebuilding the boot snapshot on every save

Problem: every flush rebuilds the 256-row initial snapshot inside the manifest —
O(n) CPU + megabytes serialized per save ([storage.ts:1224–1237, 818–824]).

1. Move the snapshot to its own key `outlineState:v3:bootSnapshot`; manifest keeps
   only `bootSnapshotRevision`. `loadInitialTreeSnapshot` reads the new key and falls
   back to the embedded `initialSnapshot` field for older manifests (keep the field
   optional in the type; do not write it anymore).
2. Write cadence: rebuild + write the snapshot (a) at most once per 10 s after the
   last state change (debounce timer in the controller), (b) on explicit
   `flushPendingSaves()`, (c) when serving `getInitialTreeSnapshot` would otherwise
   see a `bootSnapshotRevision` older than the current state revision *and* the
   sidebar boot actually requests it (lazy refresh on read is acceptable — it is the
   same O(n) work the request triggers today via the projector).
3. Tests: storage round-trip ("manifest no longer embeds the initial snapshot; boot
   snapshot loads from its own key"; "old manifests with embedded snapshots still
   load"), and a save-phase assertion ("a small incremental save does not invoke the
   snapshot projector" — the projector already has an `onProjectionBuilt` hook to
   count invocations).
4. Verify the sidebar boot Playwright spec (`tests/playwright/sidebar-first-paint.spec.ts`)
   still passes; the boot path tolerates a snapshot at most ~10 s stale, which the
   port-connected patch stream already reconciles.
5. Record before/after `v3.changeBuild`/`storage.set` bytes for a one-node change in
   PERFORMANCE_NOTES.md (`mbStringified` in the delete guard scenario should drop
   from 3 to ≈0–1).

### P0.6 Wire the baseline-detach guard (close the V5 race)

Problem: `detachPersistedStateBaselineForMutation` exists to protect the un-cloned
baseline from in-place mutation but has no call sites (RC-8/V5).

1. Call it at the top of `installStateTransition`
   ([controller.ts:4258](../../src/background/controller.ts)) and before
   `alignKnownRuntimeWindowProvenance` mutates nodes
   ([controller.ts:2728](../../src/background/controller.ts)).
2. Test: "an in-place provenance update immediately after a save does not silently
   skip persistence" — save, then within the same tick mutate provenance via the
   align path, flush again, assert storage contains the new provenance.

This is a stopgap; Phase 4 deletes the baseline entirely.

---

## Phase 1 — Journal module (pure, unwired)

New file `src/background/outline-journal.ts` + `outline-journal.test.ts`. No
controller changes in this phase.

API (all take `api: WebExtensionBrowser` like storage.ts):

```ts
export const JOURNAL_META_KEY = "outline:v4:journal:meta";
export const JOURNAL_SLOT_PREFIX = "outline:v4:journal:slot:";
export const JOURNAL_SLOT_COUNT = 64;
export const JOURNAL_SPILL_NODE_LIMIT = 2000;
export const JOURNAL_SPILL_BYTE_LIMIT = 512 * 1024;

export type OutlineJournalEntry = { seq, epoch, at, kind, label?, delta? , spill? };
export type OutlineJournalAppendResult = { seq: number; spilled: boolean };

createOutlineJournal(api, options: { epoch: number; now?: () => number }) => {
  init(): Promise<{ headSeq, tailSeq, entries: OutlineJournalEntry[] }>; // read meta+slots
  append(batch: { kind, label, delta }[]): Promise<OutlineJournalAppendResult>;
  // one storage.local.set writing ONE slot value {entries:[…]} plus meta
  prune(throughSeq: number): Promise<void>;   // advance tailSeq, remove freed slots
  pendingBytes(): number; pendingEntryCount(): number;
}
export function journalTouchedNodeIds(entries): Set<NodeId>;
export function replayJournal(state: OutlineState, entries): OutlineState;
// pure: clone-on-write apply of updatedNodes/deletedNodeIds/rootIds in seq order
```

Behaviors to test (red first, one `it` each):

1. append → init round-trips entries in order with correct seq/epoch.
2. append of a delta over the spill limits writes a `spill: true` marker without the
   delta and reports `spilled: true`.
3. ring wrap: appending past `JOURNAL_SLOT_COUNT` slots without prune throws a typed
   `JournalFullError` (the controller will translate this into "compact now").
4. `replayJournal` applies updated nodes (including `childIds` and `rootIds`
   replacement), deletes nodes, is identity-preserving for untouched nodes, and is a
   no-op for an empty entry list (returns the same state object).
5. corrupted slot (garbage value) → `init` stops at the last good seq and reports
   `truncatedAtSeq` (add to the init result), entries after it are ignored.
6. `journalTouchedNodeIds` = union of updated ids + deleted ids across entries.
7. Fault injection: `append` whose `set` rejects leaves `pendingEntryCount` unchanged
   and rethrows (caller decides; no internal retry).

Also in this phase, build the **fault-injection storage mock** as a shared test
helper `src/test/faulty-storage.test-support.ts`: wraps a memory storage with
programmable behaviors — `failNextSet()`, `tearNextSet(keepKeys: n)` (applies only
the first n keys of the items object), `latencyMs`. Unit-test the helper itself.
This helper is what makes torn-write scenarios testable across Phases 2–4 and the
new hunt lane (03/W-5).

## Phase 2 — Wire journaling into the controller

1. Construct the journal in `createBackgroundController` with
   `epoch = previous meta.epoch + 1` (read once at startup init).
2. **Produce deltas**: every call site of `scheduleStateSave` already has
   `previous`/`next`/candidates. Add a helper
   `journalDeltaForTransition(previous, next, candidateNodeIds?)` that builds
   `{rootIds?, updatedNodes, deletedNodeIds}`:
   - with candidates: like `deltaBetween` in `history.ts` (reuse it — export the
     existing function rather than re-implementing; `material` diff mode);
   - without candidates: full material diff (rare paths; fine).
3. **Append points** (keep `scheduleStateSave` calls in place during this phase —
   double-writing v3 + journal is the safety net until Phase 3):
   - every mutating command branch before its `commandAck` (awaited);
   - `installStateTransition`-producing runtime-event paths: batch through a 50 ms /
     250 ms coalescer, not awaited;
   - history replay (undo/redo): awaited, spill expected for broad deltas.
4. On `JournalFullError` or `spilled: true` → trigger an immediate v3 save flush
   (today's `flushPendingSaves`) then `prune(headSeq)`. This is the interim
   "compaction".
5. Replace P0.2's `runtimeTruthHint` mechanism: provenance/placement changes are now
   ordinary journal deltas (the hint entry kind and its startup consumption are
   deleted in Phase 5 if you kept lifecycle-journal separate — do NOT delete the
   lifecycle journal itself).
6. Startup: `journal.init()`; if entries with seq > (v3 baseline, tracked as
   `journalSeqIncluded` stored alongside the v3 manifest write — add the field to the
   manifest type now) exist → `replayJournal` over the loaded state before
   reconciliation, then schedule a full save + `prune`.
7. Tests (`controller.test.ts`):
   - "acked delete survives a simulated background restart before any state save":
     run delete, do NOT flush saves, rebuild a fresh controller over the same mocked
     storage, assert the node is gone after startup (this is invariant I-1 — make the
     test name say `I-1`);
   - same for rename, move, group, import-small;
   - "browser-native close is journaled within 250 ms" (fake timers);
   - "journal replay + later flush prunes the journal";
   - fault: "torn save followed by restart loses no acked mutation" — use
     `tearNextSet` on the v3 flush, restart, assert journal replay restored
     everything (this is the test that today's architecture cannot pass).
8. Budgets: `journalWrites` +1 allowance on mutating-command scenarios (already
   raised in P0.2; keep). `saves` unchanged.
9. PERFORMANCE_NOTES.md entry with guard numbers before/after.

## Phase 3 — v4 snapshot, verified load, recovery ladder, migration

Implement §§2–4 and 6 of [01-TARGET-ARCHITECTURE.md](./01-TARGET-ARCHITECTURE.md)
in a new `src/background/storage-v4.ts` (+ tests). Keep `storage.ts` (v3) intact for
migration reading.

Order of work, each red-green:

1. **Writer**: `outlineStateV4Snapshot(state, {generation, journalSeqIncluded,
   dirtyShardIndexes, previousManifest})` → `{setItems, removeKeysAfterCommit}`;
   shard keys carry generation; inactive manifest slot selection; meta tailSeq in the
   same set. Unit tests: full write (all shards gen 1), incremental write (2 dirty
   shards → exactly 2 shard keys + manifest + meta in setItems), old-gen keys listed
   for post-commit removal.
2. **Loader**: `loadStateV4(api)` implementing R0–R2 of the ladder, returning
   `{state, recovery: "r0"|"r1"|"r2", repair?, journalReplayCount}`.
   Tests: clean load; torn compaction (use `tearNextSet` between shard and manifest
   writes → R1 via other slot); both manifests corrupt → R2 salvage; generation
   mismatch detection; journal replay on top; property test reusing the generated
   round-trip style of `storage-v2.test.ts:749` ("keeps generated incremental v4
   compactions + journal replays loadable as the exact next state" — drive ~200
   random mutate/journal/compact/crash steps against the faulty mock).
3. **Compactor in the controller**: replace the v3 save scheduler innards: triggers
   (48 entries / 1 MB / 60 s / spill / explicit flush), dirty-set from
   `journalTouchedNodeIds`, backoff on failure (reuse P0.3 pattern), prune+GC after
   success. `flushPendingSaves()` keeps its name and external contract (drains
   journal into a compaction) so tests and shutdown callers don't change.
4. **Migration**: §6 of the architecture doc, in the startup path before normal v4
   load. Tests: v3 store → first v4 startup migrates, verifies, deletes legacy keys,
   writes `outline:v4:migrationBackup`; corrupted-v3 → salvage path feeds migration;
   migration write failure → legacy keys untouched, incident, retry next startup;
   "legacy keys absent after successful migration"; "v2-only store migrates".
5. **Boot snapshot**: move P0.5's key to `outline:v4:bootSnapshot` (mechanical).
6. **Delete the v2 silent path**: `loadStateWithMetadata` v2 branch now exists only
   inside migration (R3). Adjust P0.4 tests accordingly (they become migration
   tests).
7. New guard scenario (budget addition, explicit): add a `compaction-after-burst`
   scenario to the perf harness — 20 mixed mutations, then trigger compaction;
   budgets: `saves: 1` (the compaction), `journalWrites ≤ 21`, set
   `totalWithSaveFlushMs` from the measured value + 20% headroom. Add to
   `scripts/runtime-perf-budgets.json` and document in PERFORMANCE_NOTES.md.
8. Run the full matrix: `pnpm test`, `pnpm perf:runtime-guard`,
   `pnpm perf:sidebar-projection-guard`, `pnpm test:soak`,
   `pnpm exec playwright test` (first-paint, options, projection hunt specs),
   `pnpm trace-hunt:runtime` regression replay.

## Phase 4 — Delete the scaffolding (the payoff)

Only after Phase 3 has soaked (suggested: 7 days of dogfooding with incidents clean —
see 03/W-6):

1. Remove `lastPersistedState`, `deferPersistedStateBaselineClone`,
   `detachPersistedStateBaselineForMutation` (incl. the P0.6 wiring),
   `candidateSaveRequiresFullDiff`, `pendingSaveCandidateNodeIds`,
   `pendingSaveRequiresFullDiff`, and the `previousState`/`candidateNodeIds` options
   of the save path. `candidateNodeIds` stays for patches/runtime-index only.
2. Remove `v3CandidatePromotionReason` and v3 incremental-write code paths from
   `storage.ts`; keep v3/v2 *readers* for one release cycle (migration), then delete.
3. Demote `preserveClosedSubtreesForRuntimeTransition` to detection: still compute on
   refresh/startup, but if `restoredNodeIds` is non-empty record the incident and—new—
   keep the restoration (safety) while filing the trace signature into the runtime
   hunt corpus. After 30 clean days, gate the guard behind a build flag default-off.
   (Do not delete outright; it is the only model-level detector.)
4. Demote `normalizeLoadedV3Structure`'s successor (the v4 referential verify) to
   R2-only; R0/R1 loads with verification failures must route to the ladder, not
   silent-repair.
5. Simplify the save scheduler: the dual quiet/max interaction timing collapses into
   journal coalescing (50/250 ms) + compaction triggers. Delete
   `SAVE_QUIET/MAX/INTERACTION_*` constants and `saveScheduleForCommand` if nothing
   else consumes them.
6. Update `ARCHITECTURE.md` (Persistence section, Important Invariants, Tradeoffs),
   the `Current Asymptotics Audit` table in `PERFORMANCE_NOTES.md` (use §8 of the
   architecture doc), and create `INVARIANTS.md` per 03/W-3.
7. Re-baseline budgets downward where the guard now over-performs (tighten, never
   loosen): expected — `restore-last-transient-echo.firstBroadcastMs` back to 20–23,
   `totalWithSaveFlushMs` cuts across mutating scenarios.

## Phase 5 — Optional consolidations (separate decisions, not prerequisites)

- Fold `runtime-lifecycle-journal.ts` into the v4 journal as `intent`/`commit` entry
  kinds; startup recovery reads one stream. Delete the standalone journal module.
- History storage: `outlineHistory` is still a monolithic key rewritten per history
  save; page the undo/redo stacks (`outlineHistory:v2:<i>`) and cap entry payload
  sizes, or derive redo/undo windows from the journal itself.
- Maintained counters (nodeCount/closedCount) on the controller to drop the last
  O(n) pass in compaction manifest builds.
- Sidebar `getState` transport: with v4, full hydration could stream shards directly
  from storage in the sidebar process instead of structured-clone messaging — only if
  profiles show transport is the next bottleneck.

## Verification matrix (run at the end of every phase)

| Check | Command |
| --- | --- |
| Unit/controller/storage | `pnpm test` |
| Runtime perf budgets | `pnpm perf:runtime-guard` |
| Projection guard (if sidebar touched) | `pnpm perf:sidebar-projection-guard` |
| Trace regressions | `pnpm trace-hunt:runtime` (regression replay mode) |
| Generated soak | `pnpm test:soak` |
| Browser behavior | `pnpm exec playwright test --reporter=list` |
| Asymptotics doc current | review `PERFORMANCE_NOTES.md` audit table |
