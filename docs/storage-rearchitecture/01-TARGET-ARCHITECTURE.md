# Target Architecture: v4 Persistence — Journal + Verified Snapshot

Goal: make durability O(changed bytes) on the interaction path and reads verified and
self-healing, so correctness and performance stop being a trade-off. This replaces the
v3 "incremental snapshot with trusted diffs" model.

Design principles (each maps to a root cause in [00-DIAGNOSIS.md](./00-DIAGNOSIS.md)):

1. **The unit of durable write is the mutation delta, not the state.** Commands and
   accepted browser events already produce deltas (history records
   `{rootIds, updatedNodes, deletedNodeIds}`; patches enumerate updated/deleted ids).
   Persist exactly that, append-only. Kills RC-1/RC-5/RC-6 on the hot path.
2. **The snapshot is a cache of the journal, rebuilt off the interaction path.**
   Compaction may be O(dirty shards); it never blocks an ack. Kills RC-5/RC-6.
3. **Every read is verified; every failure has a defined recovery; no fallback is
   silent.** Kills RC-2/RC-3.
4. **Dirtiness is derived from the journal, not from trusted candidate sets or a
   cloned baseline.** `lastPersistedState`, candidate promotion, and the per-save deep
   clone are deleted. Kills RC-1/RC-8 (for persistence).
5. **No reliance on multi-key `storage.local.set` atomicity.** Consistency comes from
   generation-stamped copy-on-write shard keys and double-buffered manifests
   (shadow paging), not from hoped-for atomicity. Kills RC-2.

## 1. Durability classes

| Class | Data | Mechanism | Loss tolerance |
| --- | --- | --- | --- |
| A | User content & structure: nodes, titles, order, closed subtrees, group membership, collapse, history-affecting edits | Journal entry **before ack** | Zero acked loss |
| B | Runtime bookkeeping: `live` refs, `active`, `runtimeProvenance`, placement | Journal entry, append ≤250 ms after transition (not awaited by ack unless part of a Class-A delta) | ≤250 ms window; reconstructable from runtime snapshot + provenance entries |
| C | Derived/diagnostic: boot snapshot, incident log, perf traces | Debounced/idle writes | Freely losable |

Today Class B gets synchronous full flushes while Class A waits up to 30 s — inverted.
v4 gives A the strongest guarantee and B a cheap bounded one.

## 2. Storage schema (v4 keys)

```
outline:v4:manifest:a        ┐ double-buffered manifests; loader picks the
outline:v4:manifest:b        ┘ highest-generation VALID one
outline:v4:nodes:<idx>:<gen> 32 logical shards; key embeds the generation that
                             wrote it (copy-on-write keys, shadow paging)
outline:v4:journal:meta      { epoch, headSeq, tailSeq }
outline:v4:journal:slot:<i>  i ∈ [0, 64); each slot holds a batch of entries
outline:v4:bootSnapshot      InitialTreeSnapshot + { revision, journalSeq }
outlineHistory               unchanged (phase 5 candidate)
runtimeLifecycleJournal:v1   unchanged initially; folded into the journal in phase 5
tabsOutlinerIncidentLog:v1   unchanged mechanism, new policy (anomalies only)
```

**Order pages are eliminated.** Stored node records carry `childIds` inline again.
Rationale: pages existed so a same-parent reorder wouldn't rewrite a whole shard; in
v4 the journal absorbs high-frequency reorders and the compactor rewrites dirty shards
wholesale anyway. This deletes the childCount/page consistency machinery, the
`v3.orderPageKeys/orderPageRead/orderAttach` load phases, and the measured 510 ms /
7,062-key order-page read fanout (PERFORMANCE_NOTES.md 2026-05-26). Load becomes:
2 round trips, ~34 + ≤64 keys total.

### Manifest contents

```jsonc
{
  "version": 4,
  "generation": 17,            // monotonically increasing across compactions
  "epoch": 3,                  // background lifetime counter (see §7)
  "journalSeqIncluded": 5821,  // all journal entries ≤ this are reflected in shards
  "rootIds": [...],
  "nodeCount": 51234, "closedCount": 49120,
  "shardGenerations": [17, 12, 12, 17, ...],  // 32 entries: the gen that last wrote each shard
  "bootSnapshotRevision": 1718000000000,
  "savedAt": 1718000000000
}
```

A shard key for index 3 at generation 17 is `outline:v4:nodes:03:17`; its value also
embeds `{ shardIndex: 3, generation: 17 }` for cross-checking.

### Journal entry

```jsonc
{
  "seq": 5822,                 // global, monotonic
  "epoch": 3,
  "at": 1718000000123,
  "kind": "command" | "runtimeEvent" | "historyReplay" | "recovery",
  "label": "deleteNode",       // diagnostic only
  "delta": {
    "rootIds": [...],          // present only when roots changed
    "updatedNodes": [ /* full OutlineNode records incl. childIds */ ],
    "deletedNodeIds": [ ... ]
  }
}
```

Replay is a pure overwrite (`nodes[id] = node`, delete ids, replace rootIds) —
order-dependent only on `seq`, no operational semantics, hence no replay-determinism
risk. `touchedIds(entry) = updatedNodes[].id ∪ deletedNodeIds` is what the compactor
uses to compute dirty shards — replacing `candidateNodeIds` with a durable,
self-consistent source.

**Size cap / spill rule:** if a single delta touches more than `JOURNAL_SPILL_NODE_LIMIT`
(2,000) nodes or serializes over `JOURNAL_SPILL_BYTE_LIMIT` (512 KB) — imports, huge
flattens, history replays — do not journal the delta; instead append a marker entry
`{kind, spill: true}` and trigger an immediate compaction (which is what a full save
is today, so worst case equals current behavior).

## 3. Write protocol

### 3.1 Mutating command (Class A)

```
1. (lifecycle commands only) append journal INTENT via runtimeLifecycleJournal (unchanged)
2. browser adapter side effects (unchanged)
3. apply model op in memory; installStateTransition (unchanged)
4. broadcast compact patch (unchanged, still not awaited)
5. journalAppend({delta})            ← awaited; one small storage.local.set
6. return commandAck
```

Step 5 replaces: `scheduleStateSave` + checkpoint `flushPendingSaves()`. Perceived
command latency gains a single small `set` (~1–5 ms synthetic; ~10–30 ms real Firefox)
instead of a 0.7–1.3 s full flush. If real-browser measurement shows journal-append
p95 > 30 ms, the documented fallback is ack-then-append with a 250 ms max-delay
(Class A demoted to a 250 ms window — still 20–120× tighter than today's 5–30 s).
Decide by measurement in Phase 2; default is ack-after-append.

### 3.2 Accepted browser event (Class B, e.g. native close, tab create/move)

Same as 3.1 without an ack: append is scheduled with `quiet 50 ms / max 250 ms`
coalescing (bursts of events become one entry batch in one slot write).

### 3.3 Compaction (replaces the deferred save)

Trigger: any of — journal ≥ 48 entries; journal ≥ 1 MB total; 60 s since last
compaction with non-empty journal; spill marker; explicit `flushPendingSaves()`
(tests/shutdown); migration.

```
1. S := current in-memory state; h := current journal headSeq
2. dirty := shards of touchedIds of all journal entries in (manifest.journalSeqIncluded, h]
3. newGen := manifest.generation + 1
4. one storage.local.set:
     - for each dirty shard idx: outline:v4:nodes:<idx>:<newGen> built from S
     - inactive manifest slot := new manifest {generation:newGen, shardGenerations
       (dirty→newGen), journalSeqIncluded:h, counts, rootIds}
     - outline:v4:journal:meta with tailSeq := h
5. on success: storage.local.remove old-generation keys of the dirty shards and
   consumed journal slots (failure here is harmless garbage, collected next time)
6. on failure: nothing logically changed (the other manifest slot still references
   only untouched keys); retry with exponential backoff (1 s, 4 s, 16 s, then on next
   trigger); record incident `compactionFailed`
```

Counts/rootIds for the manifest come from S directly; the only O(n) pass is
`Object.values` for counts — acceptable off-path, and removable later via maintained
counters.

### 3.4 Boot snapshot (Class C)

Rebuilt and written as its own key: debounced ≥10 s after the last mutation, and at
every compaction. Never rebuilt synchronously inside a flush (deletes the per-save
O(n) projection rebuild, RC-6's biggest line).

## 4. Read protocol (startup)

```
1. get [manifest:a, manifest:b, journal:meta]                         (1 round trip)
2. m := valid manifest with highest generation (validity: shape check)
3. get m's 32 shard keys + journal slots in [tailSeq..headSeq]        (1 round trip)
4. verify each shard: value.generation === m.shardGenerations[idx] and shardIndex matches
5. materialize nodes (childIds inline); referential verify (every childId resolves,
   no duplicates, roots exist)
6. replay journal entries with entry.seq > m.journalSeqIncluded in seq order
7. final verify; if journal was non-empty or any repair occurred → schedule compaction
```

### Recovery ladder (every step below the first records an incident and schedules an
immediate compaction; none is silent):

| Step | Condition | Action |
| --- | --- | --- |
| R0 | manifest m verifies, replay clean | normal load |
| R1 | m fails (shard gen mismatch / referential failure) | try the other manifest slot + full journal replay (its shard keys are untouched by construction) |
| R2 | both manifests fail | salvage: union all readable `outline:v4:nodes:*` at the highest readable generation per shard, run structural repair (reuse `normalizeLoadedV3Structure` logic), replay journal, surface a diagnostics banner |
| R3 | no v4 keys at all, legacy keys exist | legacy v3/v2 load (migration path, §6) |
| R4 | nothing stored | bootstrap from windows (genuinely first run) |

`bootstrapFromWindows` is reachable **only** at R4. The v2 silent fallback is deleted.

### Crash matrix

| Crash point | Outcome on restart |
| --- | --- |
| Before journal append | command not acked; at most one visually-broadcast edit reverts (ms window) |
| After append, before compaction | replay restores it — zero loss |
| Mid-compaction `set` | active manifest slot + its keys untouched → R0/R1 load, journal replay covers everything; leftover `<newGen>` keys are garbage-collected |
| After compaction `set`, before `remove` | stale old-gen keys ignored (manifest doesn't reference them), removed at next compaction |
| Mid journal-slot write | slot fails shape check → treated as absent; entries ≤ last good seq replay; at most the in-flight batch (≤250 ms of Class-B events or one un-acked command) lost |

## 5. What this deletes / demotes (the payoff)

| Today | v4 |
| --- | --- |
| `lastPersistedState` baseline + deferred deep clone + dead `detachPersistedStateBaselineForMutation` | **Deleted** — compactor reads current state + journal-derived dirty set |
| `candidateNodeIds` threading into saves, `candidateSaveRequiresFullDiff`, `v3CandidatePromotionReason` | **Deleted** from persistence (candidates remain for patches/index, where wrongness is visible, not data-losing) |
| Runtime-truth checkpoint flushes before ack ([controller.ts:4339–4388]) | **Deleted** — journal gives Class A/B durability |
| Save scheduler dual timing + `saveAfterInFlight` re-arm complexity | Simplified to journal debounce + compaction trigger |
| Per-save incident log write | Incident policy: anomalies only (see 03, W-6) |
| Per-save manifest + embedded-snapshot rebuild | Manifest only at compaction; boot snapshot debounced (§3.4) |
| Order pages + childCount checks + orderAttach | **Deleted** (childIds inline) |
| Silent v2 fallback | **Deleted**; explicit ladder R0–R4 |
| Load-time silent repair as first resort | Demoted to R2 salvage with incident + banner |
| Closed-subtree guard on every refresh | Keep through Phase 3 (it runs only on full-reconcile paths whose cost it doesn't dominate); demote to assert/incident-only after 30 clean days (03, W-6) |
| `runtimeLifecycleJournal` | Unchanged now; folded into the journal as `intent` entries in Phase 5 |

## 6. Migration

On startup with no v4 manifest: load via the existing v3 (else v2/v1) path including
repair → write a complete v4 store (all 32 shards at generation 1, manifest:a, empty
journal) → **read it back and `statesMateriallyEqual`-verify** → only then delete all
legacy state keys (v3 manifest/shards/pages, v2 manifest/chunks/pages, v1
`outlineState`). Before deleting, write the portable-tree export JSON to
`outline:v4:migrationBackup`; the compactor deletes that key after 7 days. Failure at
any step leaves legacy keys in place and records an incident; next startup retries.

## 7. Assumptions and guards

- **Single writer**: MV3 gives one background at a time; restarts are sequential. As a
  cheap belt: `epoch` increments per background start (persisted in journal:meta);
  entries/manifests carry it; a loader that sees entries from an epoch *newer* than its
  own startup read re-reads once. No locking beyond that.
- **No reliance on multi-key set atomicity** anywhere (§3.3 step 6, crash matrix).
- **Quota**: Firefox `storage.local` is disk-backed; v4 transiently holds ≤2 copies of
  dirty shards + ≤1 MB journal + one-time migration backup. Bounded and small relative
  to the existing store.

## 8. Asymptotics after (replaces the relevant audit rows)

| Path | Today | v4 |
| --- | --- | --- |
| Mutating command ack | O(n) CPU + full flush when checkpointed | O(delta) journal append |
| Accepted browser event persistence | O(n) flush (checkpoint) or 1–5 s deferral | O(delta), ≤250 ms |
| Compaction | n/a (every flush is the compactor) | O(dirty shards) CPU, off-path, ≥60 s cadence |
| Startup load | manifest + 32 shards + ~7k order pages + repair | 2 round trips: 2 manifests + meta, 32 shards + ≤64 slots, + O(journal) replay |
| Baseline maintenance | O(n) deep clone per flush | none |
| Loss window (Class A) | 1–30 s (deferred) or 0 (checkpointed, at full-flush cost) | 0 at journal-append cost (~ms) |

## 9. Invariants this architecture enforces (seed for INVARIANTS.md, see 03/W-3)

- I-1 Every acked mutation survives a background restart (journal-before-ack).
- I-2 A loader never returns a state older than the newest acked mutation without
  recording an incident and surfacing a banner (no silent fallback).
- I-3 Storage consistency is verifiable from storage alone (generations + seq), never
  assumed from in-memory bookkeeping.
- I-4 Interaction-path persistence work is O(delta).
- I-5 Compaction is crash-safe at any byte boundary (shadow paging; old generation
  remains loadable until the new manifest is durably referenced).
- I-6 `bootstrapFromWindows` runs only when storage holds no outline data of any
  version.

## 10. Alternatives considered and rejected

- **Keep v3, keep patching**: rejected — RC-1/RC-2 are contract-level; each patch adds
  hot-path cost (measured) and the residual vectors V1–V5 stay open.
- **Write-through full snapshot per mutation**: correct and simple, but the 2026-05-19
  profile showed 6.9 s average full saves on real trees — the original reason v3 exists.
- **IndexedDB instead of storage.local**: real transactions and range reads, but a new
  failure domain, new mocks for the entire test/trace infrastructure, and migration risk
  for every user. The shadow-paging design achieves the needed atomicity on
  storage.local. Revisit only if measured journal-append latency on storage.local is
  unacceptable (>30 ms p95).
- **Per-node keys** (one key per node): minimal write amplification, but 100 k-key
  fanout reads are exactly the pathology PERFORMANCE_NOTES.md documents; rejected.
- **CRDT/event-sourced model rewrite**: solves problems this product doesn't have
  (multi-writer); enormous blast radius.
