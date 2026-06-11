# Diagnosis: The Storage Data-Loss Bug, the Performance Regression, and the Pendulum

Date: 2026-06-10. All file/line references are against commit `369c317`
(branch `codex/closed-subtree-load-consistency`, two commits ahead of `main`).

## TL;DR

1. **The data-loss bug is a class, not an instance.** v3 incremental persistence writes
   diffs computed against an in-memory baseline (`lastPersistedState`) scoped by
   hand-threaded `candidateNodeIds`. Storage correctness therefore depends on every
   caller supplying complete candidates, the baseline never diverging from what is
   physically in storage, saves never failing, and multi-key writes never tearing.
   None of these is verified or enforced. The two recent hardening commits (`72bc680`,
   `369c317`) patched two *instances* (stale shards after deletes; structural repair at
   load) but the contract that produced them is unchanged, so the honest answer to
   "is it fixed?" is: the two known manifestations are fixed; at least five sibling
   loss vectors remain open (§4).

2. **The worst remaining loss vector is the silent load-fallback ladder.** When any v3
   consistency check fails at load, `loadStateWithMetadata` silently falls back to the
   v2 manifest — which is frozen at v2→v3 migration time and never updated or deleted —
   and, failing that, the controller silently bootstraps a fresh outline from the
   currently open windows ([storage.ts:259–287](../../src/background/storage.ts),
   [controller.ts:1982–1984](../../src/background/controller.ts)). Both outcomes
   present as "my outline lost weeks of data" with no error surfaced. This is the most
   probable mechanism behind the original user-visible loss report.

3. **The performance regression is measured, attributable, and currently red.**
   `pnpm perf:runtime-guard` at HEAD fails 6 of 8 scenarios (§5). Causes: (a) the
   hardening added an incident-log `storage.local.set` to *every* save flush, doubling
   the save count (`saves: 2 > 1` hard-max failures); (b) "runtime truth checkpoint"
   flushes force a full storage flush before `commandAck` on restore/delete/move/close
   paths, re-attaching storage latency to perceived latency — the exact thing the
   deferred-save design existed to remove, and an explicit non-goal violation
   ("Do not make command acknowledgements wait for full persistence",
   [REMOTE_PROJECTION_REWRITE.md:19](../../REMOTE_PROJECTION_REWRITE.md)); (c) every
   save flush — even a one-node change — performs five to eight O(n) full-tree passes
   (§5.2).

4. **The pendulum is mechanical, not cultural.** The persisted artifact is a *snapshot*
   that is expensive to write, so performance work can only defer/coalesce writes;
   deferral widens the crash-loss window, so correctness work forces flushes and adds
   O(n) guards; which re-creates the latency that performance work then removes again.
   The workflow amplifies this because gates are asymmetric: perf changes must pass
   correctness lanes, but correctness fixes routinely ship without running the perf
   gate (both June-7 commits did; the guard is red at HEAD and PERFORMANCE_NOTES.md was
   last updated June 6). The escape is to change the artifact: persist an O(delta)
   journal on the interaction path and compact to a verified snapshot off it
   (see [01-TARGET-ARCHITECTURE.md](./01-TARGET-ARCHITECTURE.md)).

---

## 1. How persistence works today (summary)

- **In memory**: `OutlineState` `{version, rootIds, nodes}` where each node embeds
  `childIds`. Owned by the background controller; mutations are mostly copy-on-write
  but not always (§3, RC-8).
- **At rest (v3)**: a manifest (`outlineState:v3:manifest`) holding revision, rootIds,
  counts, shard key list, *and a full embedded 256-row initial sidebar snapshot*;
  32 hash shards of node records with `childIds` stripped to `childCount`
  (`outlineState:v3:nodes:xx`); child order stored separately in per-parent pages
  (`outlineState:v3:order:<parentId>:<pageIndex>`). History is one monolithic
  `outlineHistory` key. A tiny `runtimeLifecycleJournal:v1` records in-flight lifecycle
  command intents.
- **Save path**: mutations call `scheduleStateSave(next, schedule, candidateNodeIds)`;
  saves are deferred (1s/5s normal, 5s/30s interaction) and coalesced; a flush computes
  `outlineStateV3Changes(state, {previousState: lastPersistedState, candidateNodeIds})`
  and issues one `storage.local.set` then one `storage.local.remove`
  ([storage.ts:301–332](../../src/background/storage.ts)).
- **Correctness valves bolted onto that path** (each added by a separate incident):
  - candidate→full-diff promotion when roots change or node count decreases
    ([storage.ts:805–816](../../src/background/storage.ts), commit `369c317`);
  - full-diff when any candidate id is absent from `next.nodes`
    ([controller.ts:4915–4926](../../src/background/controller.ts), commit `72bc680`);
  - "runtime truth checkpoints": `flushPendingSaves()` awaited before `commandAck`
    whenever provenance/placement/removal changed
    ([controller.ts:1065,1078,1098,1134,1150,1162,3426,3498](../../src/background/controller.ts));
  - the closed-subtree guard re-inserting closed subtrees dropped by a reconcile
    transition ([closed-subtree-guard.ts](../../src/background/closed-subtree-guard.ts)),
    run at startup and on every accepted refresh snapshot
    ([controller.ts:1976,3487](../../src/background/controller.ts));
  - load-time structural repair `normalizeLoadedV3Structure`
    ([storage.ts:664–803](../../src/background/storage.ts), commit `369c317`);
  - an incident log written via read-modify-write on every save flush, startup, guard
    restore, repair, recovery and backup event
    ([controller.ts:5097–5099](../../src/background/controller.ts),
    [incident-log.ts:41–65](../../src/background/incident-log.ts)).

## 2. Root causes

### RC-1 — Incremental saves rest on a trusted, unverifiable diff contract

`outlineStateV3Changes` writes only what the diff between `lastPersistedState` and
`next` says changed, optionally narrowed to `candidateNodeIds`
([storage.ts:613–662](../../src/background/storage.ts)). Three independent things must
all be true for storage to stay equal to memory:

1. `candidateNodeIds` contains every changed node (threaded by hand from patch
   builders at ~10 call sites: [controller.ts:4872–4880](../../src/background/controller.ts));
2. `lastPersistedState` is byte-equivalent to what is physically in storage;
3. the previous flush physically succeeded in full.

There is no mechanism that *verifies* any of these. When (1) fails, changes are
silently never written (or stale records are never cleared — the `72bc680` bug). When
(2) or (3) fails, every subsequent incremental save diffs against a fiction, and
divergence persists until an unrelated full-diff save happens to rewrite the affected
shard. The promotion heuristics added by `369c317` catch root-set changes and net
deletions but not offsetting changes (delete one node + add one node in the same
coalesced flush with an incomplete candidate set passes all checks).

### RC-2 — No transactional boundary, no torn-write detection

A flush is one multi-key `set` followed by one `remove`
([storage.ts:322–331](../../src/background/storage.ts)). Nothing stamps shards/pages
with the manifest revision, so the loader cannot distinguish "consistent state" from
"manifest from flush N + shard from flush N−1". The only integrity signals are
incidental: `childIds.length !== childCount` ([storage.ts:586–588](../../src/background/storage.ts))
and order-page key misses — both of which abort the whole v3 load rather than recover.
`storage.local.set` atomicity across keys is an undocumented browser implementation
detail; the design depends on it without stating or testing it.

### RC-3 — Failure handling = silent fallback that manufactures data loss

`loadStateWithMetadata`: v3 invalid → try v2 → `undefined`
([storage.ts:259–287](../../src/background/storage.ts)). The v2 manifest is never
deleted or rewritten after migration (no production writer references
`STATE_V2_MANIFEST_KEY`), so it is permanently stale. `undefined` makes the controller
`bootstrapFromWindows` ([controller.ts:1982–1984](../../src/background/controller.ts)),
i.e. discard all closed/saved content. Neither path records an incident (the incident
log only fires on the *repair* path, which only runs when v3 *loaded successfully*).
So the system's response to detected corruption is to silently time-travel or wipe —
worse than crashing, because the subsequent save then overwrites good v3 data with the
stale/bootstrapped tree under the same keys. **The load-time structural repair, by
contrast, silently drops dangling children** (counts them, logs an incident, continues)
— acceptable as a last-resort salvage, but currently it is the *first* resort.

### RC-4 — Save errors are swallowed; queue dropped; no retry; baseline poisoning

`flushScheduledSave` catches any save error and only writes a perf-trace mark
([controller.ts:5023–5025](../../src/background/controller.ts)). By that point the
pending snapshot was already dequeued, so the changes will not be retried; if no later
mutation arrives, they are simply never persisted. If the failed `set` partially
applied, `lastPersistedState` (not updated on failure) no longer matches storage and
RC-1(2) fires with no recovery. Nothing forces a full-diff save after an error.

### RC-5 — One artifact, two durability classes → checkpoints on the hot path

The durable outline carries both user content (nodes/order/closed subtrees — high
value, mutation-rate low) and runtime bookkeeping (`live` ids, `runtimeProvenance`,
active flags — low value, high churn, mostly reconstructable from a runtime snapshot).
Startup classification needs provenance to be durable (otherwise restored/saved windows
are misclassified and closed subtrees get mangled — the RT-144…RT-204 family), so the
fix was to force `flushPendingSaves()` whenever runtime truth changes
([controller.ts:4339–4388](../../src/background/controller.ts)). Because the only
durable artifact is the full snapshot pipeline, durability for a few dozen bytes of
provenance costs a full flush, awaited before `commandAck`
([controller.ts:1065–1165](../../src/background/controller.ts)). In a real Firefox
profile an incremental flush averaged ~0.7s (PERFORMANCE_NOTES.md 2026-05-19/26), so
every restore/delete/move/native-close re-acquired sub-second perceived latency.

### RC-6 — Every save is O(n) CPU regardless of delta size

Per flush, independent of how small the change is:

| Cost | Where |
| --- | --- |
| Count scan of next state | [controller.ts:5076](../../src/background/controller.ts) (`outlineStateCountDetail`) |
| Count scan of baseline | [controller.ts:5077–5079](../../src/background/controller.ts) |
| Manifest rebuild: `Object.values(nodes)`, closed-count filter, shard-key set | [storage.ts:1224–1252](../../src/background/storage.ts) |
| **Full 256-row initial-snapshot projection rebuild embedded in the manifest** (tree walk + row build + serialization, megabytes) | [storage.ts:1235, 818–824](../../src/background/storage.ts) |
| Diff: full-diff field-compares whenever promotion triggers (any delete) | [storage.ts:1309–1350](../../src/background/storage.ts) |
| Changed-shard rebuild walks `Object.values(next.nodes)` even for one dirty shard | [storage.ts:1330–1339](../../src/background/storage.ts) |
| Incident log read-modify-write (extra get+set, 100-entry JSON) | [incident-log.ts:41–65](../../src/background/incident-log.ts) |
| Deferred **full deep clone of the entire state** for the next baseline | [controller.ts:4233–4245](../../src/background/controller.ts) |

The guard run (§5.1) shows `mbStringified=3` for deleting one tab: ~3 MB serialized
for a one-node change, dominated by the embedded snapshot + a ~n/32-node shard.
Because writes are inherently O(n)-ish, the *only* perf lever ever available was
deferral — which is precisely what correctness work keeps removing.

### RC-7 — Defense-in-depth layers accrete; none retires another

Lifecycle journal, checkpoints, candidate promotion, closed-subtree guard, load repair,
incident log: each was added per-incident, each costs hot-path CPU or storage I/O, and
each papers over the same missing primitive (a verifiable, atomic, cheap durability
mechanism). None establishes an invariant strong enough to delete any other. This is
why the codebase keeps getting slower *and* never becomes confidently correct.

### RC-8 — Unenforced mutation discipline forces defensive copying

Model ops are copy-on-write, but e.g. `alignKnownRuntimeWindowProvenance` mutates node
records in place ([controller.ts:2728–2736](../../src/background/controller.ts)) and
`normalizeLoadedV3Structure` mutates the loaded state in place. Hence the baseline must
be deep-cloned after every save (RC-6 last row) on a 0 ms timer; in the window before
that timer fires, an in-place mutation of shared node objects would silently poison the
baseline (diff sees "unchanged" → change never persisted). The protective
`detachPersistedStateBaselineForMutation` ([controller.ts:4247–4256](../../src/background/controller.ts))
**has zero call sites** — the intended protection was never wired up.

## 3. The original data-loss mechanism (reconstructed)

The probable production sequence that motivated this branch:

1. A delete (or delete-containing reconcile) saved with candidates that did not cover
   the deleted ids → stale node records remained in their shard while the parent's
   order page and `childCount` were updated (pre-`72bc680`).
2. Later flushes kept diffing against a baseline that believed those records were gone.
3. At some restart, a shard/page/childCount mismatch tripped a v3 load check →
   **silent v2 fallback or bootstrap** (RC-3) → user sees their outline rolled back
   weeks or emptied; the next save then *persists* the rollback.
4. The closed-subtree guard and incident log were added to catch step-3-like symptoms;
   `369c317` added load-time repair so dangling references no longer hard-fail the v3
   load. Steps 1–2 are now narrower (full-diff on deletes), but RC-1…RC-4 still permit
   the family.

## 4. Is it fixed? — Residual loss vectors at HEAD

| # | Vector | Status |
| --- | --- | --- |
| V1 | v3 load check fails → silent stale-v2 fallback / bootstrap, then overwriting save | **Open.** RC-3. Highest severity. |
| V2 | Save failure → dropped pending save, no retry, possible baseline divergence | **Open.** RC-4. |
| V3 | Candidate under-reporting with offsetting add/delete (count unchanged, roots unchanged) | **Open** (narrow). RC-1. |
| V4 | Torn multi-key write (browser crash mid-`set`, or set/remove gap) undetected at load | **Open**, partially masked by repair. RC-2. |
| V5 | Baseline poisoning via same-tick in-place mutation before the deferred clone | **Open** (narrow race). RC-8. |
| V6 | Deferred-save window (1–30 s) for outline-only edits on background death | Accepted by design, but now inconsistent: runtime metadata gets immediate flushes while user edits wait up to 30 s — the *inverse* of the value ordering. |
| — | Stale shards after delete-bearing candidate saves | Fixed by `72bc680`/`369c317` (full-diff promotion). |
| — | Dangling refs/unreachable nodes hard-failing v3 load | Fixed by `369c317` (repair) — but see V1 for the checks that still hard-fail. |

The trace-hunt evidence agrees: the dedicated closed-subtree-loss hunt (RUNTIME_TRACE_BUGS.md,
2026-06-03, 897 discovery + 278 regression traces) found no *model-level* loss — because
the hunts replay model/controller logic with a faithful storage mock. The remaining
vectors are in the storage/process-lifetime layer the hunt harness does not currently
fault-inject (no torn-write, failed-set, or kill-mid-flush traces exist). "We are not
sure" is therefore the correct current epistemic state, and §W-5/W-6 of
[03-WORKFLOW-FIXES.md](./03-WORKFLOW-FIXES.md) define how "fixed" becomes decidable.

## 5. The performance regression, quantified

### 5.1 The repo's own gate is red at HEAD

`pnpm perf:runtime-guard` (run 2026-06-10, this machine):

```
FAIL close-last-tab-removed-then-session   saves: 2 > 1 (hard-max)
FAIL close-last-session-then-tab-removed   saves: 2 > 1 (hard-max)
FAIL restore-last-transient-echo           firstBroadcastMs: 37 > 23; saves: 2 > 1
FAIL delete-last-tab                       saves: 2 > 1   (mbStringified=3)
PASS focus-last-tab
FAIL command-group-live-leaf               firstBroadcastMs: 156 > 138; saves: 2 > 1
FAIL command-move-leaf                     saves: 2 > 1
PASS command-refresh-noop
```

The second "save" is the per-flush incident-log `storage.local.set`
(`recordIncidentLog("saveFlush", …)`, [controller.ts:5097–5099](../../src/background/controller.ts));
the profile harness counts any non-journal `set` as a save
([scripts/profile-storage-metrics.mjs:22–39](../../scripts/profile-storage-metrics.mjs)).
Budgets were never loosened historically (single authorship in PR #7), so these are
true regressions introduced by `72bc680`/`369c317`.

### 5.2 Real-browser impact (projected from measured components)

- Incremental flush in real Firefox: ~688 ms avg / 1.3 s max (PERFORMANCE_NOTES.md
  2026-05-19). Checkpoint flushes put this *before* `commandAck` for restore/delete/
  move/native-close whenever provenance/placement/removal changed (RC-5).
- Incident log adds a storage read+write per flush and per startup.
- The deferred baseline deep-clone adds O(n) CPU + GC per flush (~100 k nodes).
- Per-flush CPU passes (RC-6) multiply with tree size, not change size.

### 5.3 The June-7 commits skipped the documented perf gate

- `RUNTIME_TRACE_HUNT_GUIDE.md` ("Fix-Pass Performance Gate"): "Do not promote traces
  or update RUNTIME_TRACE_BUGS.md fixed statuses while the selected perf guard is red."
- `AGENTS.md`: perf-relevant changes must update the asymptotics audit or state it
  unchanged.
- Last PERFORMANCE_NOTES.md update: Jun 6 (`186950c`). Hardening commits: Jun 7
  (`72bc680` 21:03, `369c317` 21:43). No notes entry, no budget discussion, guard red.

## 6. Why the pendulum keeps swinging (synthesis)

1. **Architecture**: the durable artifact (full snapshot, hand-diffed) makes
   *durability* and *latency* the same dial. Turning it toward safety (flush early,
   guard, verify O(n)) directly costs latency; toward latency (defer, coalesce, trust
   candidates) directly costs safety. No amount of point-fixing changes this — the
   artifact must change (journal for durability, snapshot for read performance;
   see 01).
2. **Workflow**: gates are asymmetric (perf → correctness mandatory;
   correctness → perf optional in practice and absent for the projection lane), so
   each correctness pass legally ships a perf debt, which later perf passes pay back
   by re-widening loss windows. Evidence and fixes in
   [03-WORKFLOW-FIXES.md](./03-WORKFLOW-FIXES.md).
3. **Epistemics**: "is the bug fixed?" is currently undecidable because the failure
   modes live in layers (storage faults, process death) that the otherwise excellent
   trace-hunt infrastructure does not simulate, and the only production signal (the
   new incident log) logs *every* save, burying anomalies in noise.

## 7. What to do (pointer)

- **Now (days)**: Phase 0 of [02-IMPLEMENTATION-PLAN.md](./02-IMPLEMENTATION-PLAN.md) —
  six contained fixes that re-green the guard, close V1/V2, and de-noise incidents,
  without architectural change.
- **Next (1–2 weeks)**: Phases 1–4 — the v4 journal + verified-snapshot architecture in
  [01-TARGET-ARCHITECTURE.md](./01-TARGET-ARCHITECTURE.md), which removes the
  correctness/latency coupling entirely and deletes most of the defensive layers.
- **Continuously**: [03-WORKFLOW-FIXES.md](./03-WORKFLOW-FIXES.md) — symmetric gates,
  storage fault lane, invariant registry, incident triage, decidable
  "definition of fixed".
