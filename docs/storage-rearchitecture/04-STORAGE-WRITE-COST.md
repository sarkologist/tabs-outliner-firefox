# The per-write cost ceiling: `storage.local.set` is O(total store), not O(payload)

Date: 2026-06-13. Evidence: `dist/tabs-outliner-profile-2026-06-13 copy.json`
(background traces; Firefox; store scale ~25,769 nodes / 3,901 windows / 21,867 tabs).

This continues [00-DIAGNOSIS.md](./00-DIAGNOSIS.md)..[03-WORKFLOW-FIXES.md](./03-WORKFLOW-FIXES.md).
Those documents diagnosed the *artifact* (full-snapshot, hand-diffed) and built v4 (journal +
verified snapshot) to make the interaction path O(delta). This document reports a measurement
that v4 explicitly gated a decision on, and the decision the measurement forces.

## TL;DR

1. **A single `chrome.storage.local.set` of one tiny journal slot (~1 KB) costs 1–8 s on
   this profile, and the cost is independent of payload size — it scales with the *total*
   bytes already in the `storage.local` area.** Measured: `background.journal.append`
   n=11, avg 1,711 ms, max **8,823 ms**, for writes that each persist a single
   one-entry slot. The 8,823 ms write ran **alone for ~6.8 s** with nothing else touching
   storage (only a 658 ms boot-snapshot write overlapped its first part), so this is the
   `set` itself, not opQueue serialization or save/append contention (§1).

2. **This is the fingerprint of a whole-store-rewrite backend** — Firefox's legacy JSON
   (`storage.local.lz4`, JSONFile/kinto) area, which on every `set` re-serializes +
   LZ4-compresses + atomically rewrites the *entire* area. The per-key IndexedDB backend
   (FF ≥79) cannot make a 1 KB put cost seconds. The burst-then-cheap pattern in the trace
   (8,823 ms → 48 ms → 26 ms for identical payloads) is the JSONFile `DeferredTask`
   coalescing artifact, which only that backend exhibits (§2).

3. **This silently defeats the entire point of the v4 journal.** The journal exists so an
   acked command pays one *small* `set` (~ms) instead of a full flush. When `storage.local`
   makes even a 1 KB append O(total store), the journal append is as expensive as the
   snapshot save it was meant to avoid. The architecture's central assumption —
   "small writes are cheap" — does not hold on this substrate (§3).

4. **v4 made this an explicit, measurable bet and the bet has now lost.**
   [01-TARGET-ARCHITECTURE.md §10](./01-TARGET-ARCHITECTURE.md) rejected IndexedDB
   *"Revisit only if measured journal-append latency on storage.local is unacceptable
   (>30 ms p95)."* §3.1 set the same 30 ms trigger for the ack path. Measured median is
   ~1.2 s (≈40× over) and max ~8.8 s (≈290× over). **The documented trigger to move the
   bulk store off `storage.local` has fired** (§4).

5. **Fix (proposed): move the bulk node shards and the journal into an extension-owned
   IndexedDB database, behind a thin key-value port, keeping the v4 journal/snapshot
   *algorithm* byte-for-byte identical.** `storage.local` then holds only kilobytes of
   pointers, so any O(store) backend rewrites only kilobytes; the bulk goes to a store
   where a put is genuinely O(payload) and multi-key writes are *actually* transactional
   (strengthening, not weakening, the I-1..I-6 invariants). Staged; the migration reuses
   the existing verify-before-delete protocol (§6).

6. **Shipped now (low-risk):** an opt-in **storage census** that measures, in the field,
   the three facts I cannot read from the repo — which backend is active (probe-write
   timing), total bytes per key prefix, and whether stale shard generations are leaking.
   It is read-only plus one self-cleaning probe key, gated behind the existing profiling
   toggle, and surfaced through the incident log + perf trace already bundled into exported
   profiles. This is the "measure before you cut" baseline for the migration and the
   decidable before/after metric (§7).

---

## 1. The measurement

All-storage-touching background spans from the capture, relative to the first
(`state.initialSnapshot.load` at t=0), reconstructed from `snapshot.background.entries`
(`atMs` = wall-clock span start; `end = atMs + durationMs`):

```
name                        start_s  end_s   dur_ms  detail
state.save                  2.82     10.831  8011    v4.compact full, setKeys:33, gen:2432
state.bootSnapshot.write    12.284   12.342  58
journal.append              14.551   15.555  1004    entries:1
state.save                  19.576   19.844  268     v4.compact dirty:4,  setKeys:5,  removeKeys:32, gen:2433
journal.append              27.824   29.195  1371    entries:1
state.bootSnapshot.write    29.091   29.9    809
journal.append              29.149   29.993  844     entries:1
state.save                  34.158   34.774  616     v4.compact dirty:13, setKeys:14, removeKeys:4,  gen:2434
journal.append              38.612   40.363  1751    entries:1
state.save                  41.428   42.553  1125    v4.compact dirty:27, setKeys:28, removeKeys:13, gen:2435
journal.append              46.707   47.601  894     entries:1
journal.append              48.614   50.198  1584    entries:1
journal.append              52.824   53.798  974     entries:1
state.save                  54.814   55.948  1134    v4.compact dirty:30, setKeys:31, removeKeys:27, gen:2436
state.bootSnapshot.write    57.116   57.774  658
journal.append              57.151   65.974  8823    entries:1   ← the monster
journal.append              64.545   66.047  1502    entries:1   (queued behind the monster; ~73 ms real set)
journal.append              66.009   66.057  48      entries:1
journal.append              66.528   66.554  26      entries:1
state.bootSnapshot.write    67.181   67.251  70
state.save                  67.204   67.742  538     v4.compact dirty:10, setKeys:11, removeKeys:30, gen:2437
```

Three facts fall straight out of this table:

- **Payload-independence.** Every `journal.append` writes one 1-entry slot + a tiny meta
  key (`detail.entries:1`). A full `state.save` (gen 2432) writes 33 keys including ~all
  32 node shards (megabytes). The 1 KB append (8,823 ms) is *more* expensive than the
  33-key full save (8,011 ms). Write cost has essentially nothing to do with what the
  write contains.

- **The 8,823 ms `set` ran alone.** Its window is 57.151 → 65.974 s. The only overlapping
  storage span is `state.bootSnapshot.write` 57.116 → 57.774 (658 ms) at the very start.
  From 57.774 to 64.545 — ~6.8 s — *nothing else touched storage*. (The append at 64.545 is
  the next journal op blocked on the opQueue behind the monster; once the monster drains at
  65.974, that op's own `set` takes ~73 ms.) So the cost is the single `storage.local.set`,
  not queueing and not contention from a concurrent save.

- **Burst-then-cheap.** Immediately after the monster: appends of **48 ms** and **26 ms**,
  a 70 ms boot snapshot, and a 538 ms save — for the *same* 1-entry payload that cost
  seconds moments earlier, and with the store no smaller (the gen-2437 `removeKeys:30`
  sweep happens *after* the fast appends). Write latency is bimodal and depends on I/O
  subsystem state, not on the data.

Aggregates across the capture: `journal.append` n=11 / avg 1,711 / max 8,823 ms;
`state.save` n=6 / avg 1,948 / max 8,011 ms; `state.bootSnapshot.write` n=5 / avg 376 /
max 809 ms; `state.initialSnapshot.load` n=10 / avg 346 / max 556 ms. Generation advanced
2432 → 2437 over the 67 s window (≈1 compaction / 10 s under active editing).

## 2. Why one small `set` costs 1–8 s

A write whose cost is **independent of payload but proportional to total stored bytes** can
only come from a backend that rewrites an amount of data proportional to the whole area on
every `set`. In Firefox there is exactly one such `storage.local` backend:

- **Legacy JSON backend (`storage.local.lz4`, `JSONFile` + the kinto-derived store).**
  Every `set` updates an in-memory object, then serializes the **entire area** to JSON,
  LZ4-compresses it, and atomically writes temp-file → rename → `fsync`. Cost ≈ O(total
  store bytes). With ~25.7 k node records inline-sharded (the portable-tree export of this
  store is ~13 MB), a full serialize+compress+fsync is seconds, and a bad `fsync`/OS
  write-back/GC moment pushes one write to ~8.8 s. The backend debounces via a
  `DeferredTask`, so a burst of `set`s within one in-flight flush coalesces and the later
  ones resolve in milliseconds — **exactly** the 8,823 → 48 → 26 ms tail observed in §1.

- **IndexedDB backend (`ExtensionStorageIDB`, default for new extensions since FF 79).**
  Each storage key is its own record; `set({slot, meta})` is two `put`s in one readwrite
  transaction = O(payload) + one commit `fsync`. A lone 1 KB put cannot take 6.8 s. If the
  IDB backend were active, *all* the appends would be uniformly fast regardless of the 13 MB
  of node data sitting in other keys.

The measured behavior is only consistent with the **legacy JSON backend** (or a path
behaving identically to it). The most likely reason a long-lived FF 127 profile is still on
it: the per-extension JSON→IDB migration is lazy and one-shot, and for a store that was
already multi-megabyte it can fail or be skipped and then never retried, pinning the
extension to the JSON backend. **An extension cannot reliably force the IDB backend from its
manifest or code** — which is the second half of the argument for §6 (own the substrate
instead of hoping for it). §8 gives the user a way to confirm the backend directly.

### What it is *not* (ruled out)

- **Not payload size.** The 1 KB append ≈ the 33-key megabyte save (§1). Shrinking the
  per-write payload (the third option floated in the brief) cannot help on a whole-store
  backend — the payload is already ~1 KB and irrelevant to the cost.
- **Not opQueue / save contention.** The monster ran alone for ~6.8 s (§1). The journal's
  `opQueue` (outline-journal.ts:130) and the deferred-save engine were idle through that
  window. (Queueing *is* visible — the 1,502 ms append at 64.545 is mostly opQueue wait —
  but that is downstream of slow `set`s, not the cause.)
- **Not, primarily, key/shard leakage.** Even with *zero* stale keys, the ~13 MB of
  legitimate node records is an irreducible floor for any whole-store-rewrite backend:
  ~1–2 s per `set` minimum. Leaked stale `outline:v4:nodes:<idx>:<gen>` generations
  (see §5) would inflate the floor further, but pruning them does not change the
  asymptotics — it lowers a constant. (We should still prune; it is just not the fix.)

## 3. The architectural consequence: the journal's premise is violated

v4's hot-path contract ([01 §3.1](./01-TARGET-ARCHITECTURE.md)) is:

> 5. `journalAppend({delta})` ← awaited; one small `storage.local.set`
> 6. return `commandAck`
>
> *"Perceived command latency gains a single small `set` (~1–5 ms synthetic; ~10–30 ms real
> Firefox) instead of a 0.7–1.3 s full flush."*

On this substrate that single small `set` is **1,711 ms average, 8,823 ms worst case**.
The journal does not make the ack cheap; it relocates the same whole-store-rewrite cost to a
different key. The deferred snapshot save (which the journal was supposed to keep off the
perceived path) *also* pays it. Both durability mechanisms are gated by the same
O(total-store) `storage.local.set`, so the delete-lag ceiling the
[delete-lag diagnosis](../../) found — "even with writes coalesced and deferred off the
command ack, deletes still queue seconds of storage I/O on the single background thread" —
is structural and cannot be closed by any amount of coalescing/deferral while the bulk lives
in `storage.local`. (The concurrent change that batches per-command appends reduces the
*count* of these writes during a burst; it cannot reduce the per-write cost, which is this
document's subject. The two compose.)

## 4. The trigger v4 set has fired

This is the decisive alignment with the existing plan. v4 did not reject IndexedDB
unconditionally — it rejected it *pending a measurement it named*:

> [01 §10](./01-TARGET-ARCHITECTURE.md): **IndexedDB instead of storage.local** … "The
> shadow-paging design achieves the needed atomicity on storage.local. **Revisit only if
> measured journal-append latency on storage.local is unacceptable (>30 ms p95).**"
>
> [01 §3.1](./01-TARGET-ARCHITECTURE.md): "If real-browser measurement shows journal-append
> p95 > 30 ms, the documented fallback is ack-then-append … **Decide by measurement in
> Phase 2.**"

| Metric (this profile) | Value | vs. 30 ms trigger |
| --- | --- | --- |
| journal-append median | ~1,200 ms | ~40× over |
| journal-append average | 1,711 ms | ~57× over |
| journal-append max (n=11 ⇒ ≈p95) | 8,823 ms | ~294× over |

The trigger is met by every reasonable reading of "p95," by ~2–3 orders of magnitude. The
fallback §3.1 floats (ack-then-append within a 250 ms window) does **not** rescue this case:
it bounds the *loss window*, not the *write cost*; a 250 ms-deferred 8 s write still saturates
the single background thread for 8 s and still lags the next interaction. The condition the
authors wrote down for revisiting the substrate is satisfied.

## 5. Secondary finding: stale shard generations can leak un-swept

Old-generation shard keys (`outline:v4:nodes:<idx>:<gen>`) are reclaimed **only** by the
fire-and-forget `removeKeysAfterCommit` after each compaction
([persistence-coordinator.ts:404-408](../../src/background/persistence-coordinator.ts):
`void api.storage.local.remove(...).catch(...)`), and that list is computed solely from the
*one* manifest being evicted this round ([storage-v4.ts:150-161](../../src/background/storage-v4.ts)).
There is **no periodic sweep** of `outline:v4:nodes:*` by generation. Consequences:

- An MV3 background can be torn down before a fire-and-forget `remove` lands; on this
  backend each `remove` is itself an O(store) rewrite (slow, more likely to be interrupted).
- A `remove` that fails or is dropped is never retried — the *next* compaction collects a
  *different* manifest's keys, so any miss is a **permanent** leak.

Generation 2432→2437 here (and 2313 in an earlier same-day capture) means thousands of
compactions over this store's life. Steady state *should* be ~2–3 generations × 32 shards
≈ 96 shard keys, but only if every fire-and-forget remove succeeded. Whether it actually has
is unknown from the repo — it is one of the things the §7 census measures. Even if it has
leaked, see §2: pruning lowers the constant, it does not lift the ceiling.

## 6. Proposal: own the substrate (bulk + journal → IndexedDB), keep the algorithm

Move the data whose size dominates the rewrite — the 32 node shards — and the hot-path
journal into an **extension-owned IndexedDB database**, leaving `storage.local` holding only
small, low-churn pointers (manifests, journal meta, preferences, incident log, boot
snapshot, migration backup-meta). The v4 journal/snapshot *algorithm* (generations,
shadow-paged double-buffered manifest, recovery ladder R0–R4, spill rule, replay) is
**unchanged** — only the bytes move to a substrate where the algorithm's premise ("a small
write is small") is true.

### 6.1 The seam

Introduce a minimal port — the exact subset of `storage.local` the storage modules already
use:

```ts
type KeyValueStore = {
  get(keys: string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
};
```

`outline-journal.ts`, `storage-v4.ts`, and the v4 paths of `persistence-coordinator.ts`
already receive `api: WebExtensionBrowser` and call only `api.storage.local.{get,set,remove}`.
Re-point them at an injected `KeyValueStore`. Two implementations:

- `storageLocalKvStore(api)` — trivial pass-through to `api.storage.local` (today's behavior;
  keeps every existing test and the whole trace/fault harness working unchanged — this
  directly answers the §10 objection *"new mocks for the entire test/trace infrastructure"*:
  there is **one** seam, and the in-memory `createFaultyStorage` mock already satisfies it).
- `indexedDbKvStore(dbName, storeName)` — one object store keyed by the string key; `get`
  is `getAll`/`getMany`, `set`/`remove` are one readwrite transaction. A 1 KB put is
  O(1 KB); a multi-key `set` is a **real transaction** (atomic commit), which *strengthens*
  RC-2 / I-5 (shadow paging stops being load-bearing for atomicity and becomes
  belt-and-suspenders).

### 6.2 Staging (each step independently shippable + gate-green; the storage-fault soak,
[W-4](./03-WORKFLOW-FIXES.md)/[W-8](./03-WORKFLOW-FIXES.md), gates every step that touches
save/load shape)

1. **Port extraction (pure refactor, no behavior change).** Add `KeyValueStore` +
   `storageLocalKvStore`; thread it through journal / storage-v4 / coordinator. Gate proves
   equivalence. *Risk: low (mechanical seam, no new failure domain).* Its own reviewed PR.
2. **Journal → IndexedDB, measured.** Back the journal's KV with `indexedDbKvStore`. The
   journal is the right first mover: it is the hot-path write whose p95 §4 condemned, it is
   small/append-only with a strong test suite, and it is self-healing (corrupt slot →
   truncate at last good seq). Existing journal keys are ephemeral (pruned every
   compaction), so "migration" is: on first run, drain the old `storage.local` journal once
   and replay, then write only to IDB. Re-measure journal-append p95 in a real profile;
   expect ms. *Risk: medium; behind the fault soak + I-1 restart tests.*
3. **Shards → IndexedDB, with the existing verify-before-delete migration.** Mirror
   [01 §6](./01-TARGET-ARCHITECTURE.md): write the full v4 store into IDB, read back and
   `statesMateriallyEqual`-verify, write the portable-tree backup, only then delete the
   `storage.local` shard keys. Failure leaves `storage.local` authoritative; next startup
   retries. This is the change that lifts the ceiling — `storage.local` drops from ~13 MB
   to ~KB, so *every remaining* `storage.local` write (manifest, boot snapshot, incident
   log, prefs) also becomes fast as a side effect. *Risk: medium-high; full fault-soak +
   the W-6 dogfood window before the optional step 4 cleanup.*
4. **(Optional) Simplify once real transactions exist.** With atomic IDB transactions,
   evaluate collapsing the double-buffered manifest / generation bookkeeping that existed
   only to fake atomicity on `storage.local`. Defer until step 3 has soaked.

### 6.3 The three §10 objections, answered

| §10 objection to IndexedDB | Resolution |
| --- | --- |
| "a new failure domain" | True, but IDB writes are *transactional* — strictly safer per-write than the legacy JSON backend's whole-file rewrite. The recovery ladder R0–R4 and crash matrix carry over unchanged; the crash points only get *more* atomic. |
| "new mocks for the entire test/trace infrastructure" | Avoided by the single `KeyValueStore` seam (§6.1). Existing tests inject the in-memory store; only the new `indexedDbKvStore` needs an IDB fake (e.g. `fake-indexeddb`), scoped to its own unit tests. |
| "migration risk for every user" | Reuse the **proven** v4 verify-before-delete migration (01 §6) that already shipped for v3→v4: write+verify IDB, keep `storage.local` authoritative until verified, portable-tree backup, retry on failure. Staged so journal (ephemeral, zero migration) lands first. |

### 6.4 Invariants

I-1..I-6 ([01 §9](./01-TARGET-ARCHITECTURE.md)) are properties of the journal/snapshot
*algorithm*, which is unchanged; the substrate swap preserves them and **strengthens** I-3
(consistency verifiable from storage) and I-5 (compaction crash-safe at any byte boundary)
because IDB gives real transaction atomicity rather than relying on undocumented multi-key
`set` atomicity (RC-2). Durability is not weakened at any step: each step keeps the prior
substrate authoritative until the new one is verified, exactly as v3→v4 did. Quota is fine —
`unlimitedStorage` is already granted and IDB shares the origin's unlimited pool.

## 7. Shipped now: the storage census (low-risk first step)

The brief asked me to determine the backend, key/shard bloat, and total store size. None is
readable from the repo or the profile JSON — they are properties of the live Firefox profile.
So the low-risk implementation that "exists" is the instrument that reads them in the field,
which is also the correct first move before any migration: **measure, then cut.**

`src/background/storage-census.ts` computes, from one `storage.local.get(null)`:

- total key count and total serialized bytes;
- bytes + key count grouped by prefix (`outline:v4:nodes:`, `outline:v4:journal:`,
  `outline:v4:manifest:`, `outlineHistory`, `outline:v4:bootSnapshot`, legacy
  `outlineState:v3:`/`v2:`, migration backup, other) — quantifies §3 (what dominates) and
  §5 (leakage: `nodeShardKeyCount` and `nodeShardGenerationSpan` > ~3 ⇒ leak);
- a **backend probe**: write one ~1 KB key, time it, remove it (`probeSetMs`). A 1 KB `set`
  taking ≫ a few ms ⇒ whole-store-rewrite backend (§2). This is the definitive, repeatable,
  field-deployable backend test (§8 is the manual equivalent).

It records a `storageCensus` incident-log entry (visible in the options page, and bundled
into exported profiles via `snapshot.incidentLog`) plus a `background.storage.census` perf
mark. It is **read-only except one self-cleaning probe key** (`tabsOutlinerStorageProbe:v1`,
matched by no loader/migration filter; a failed remove leaves one harmless ignored key), and
runs **only when the user enables profiling** — never on the normal startup path. It changes
no save/load/journal code, so it cannot affect durability.

This produces the baseline number the migration is judged against: re-run the census after
§6 step 3 and `probeSetMs` for the journal/shard data should drop from seconds to
milliseconds — a [W-6](./03-WORKFLOW-FIXES.md)-style decidable definition of fixed for the
performance ceiling.

## 8. How to confirm the backend directly (user action)

I cannot read the user's Firefox profile from here. To confirm §2 manually:

- `about:config` → `extensions.webextensions.ExtensionStorageIDB.enabled` (should be
  `true`); and look for a per-addon migration pref/telemetry
  (`extensions.webextensions.ExtensionStorageIDB.migrated.tab-session-outliner@example.local`).
- Or inspect the profile directory: a large `storage/default/moz-extension+++…/idb/*` for
  this extension ⇒ IDB backend; a `browser-extension-data/<id>/storage.local.lz4` that is
  multi-MB and changes mtime on every edit ⇒ legacy JSON backend.
- Or just read `probeSetMs` from the §7 census: ≫ few ms ⇒ whole-store rewrite.

Either way the §6 fix is correct: if legacy, it bypasses the slow backend; if IDB-but-still-
slow, an extension-owned store removes the dependency on the platform's opaque behavior.

## 9. Recommendation

- **Now:** land the §7 census (this PR); capture one census from the affected profile.
- **Next:** §6 step 1 (KV-port refactor) as its own reviewed PR; then §6 step 2 (journal →
  IDB) and re-measure against the 30 ms trigger.
- **Then:** §6 step 3 (shards → IDB) behind the full storage-fault soak and the W-6 dogfood
  window. This is the change that retires the delete-lag ceiling.
- **Cheap robustness, independently:** add a bounded startup sweep that removes
  `outline:v4:nodes:*` keys referenced by *neither* stored manifest (safe predicate: never
  delete a key either manifest slot points at), to cap the §5 leak. Behind the fault soak.
