# Project state — what's happening now

A snapshot of in-flight work and current posture that is **not** derivable from `main`'s
code or git history alone. Update this when a PR lands or a new effort starts; keep it
short so it stays cheap to maintain. Last updated: **2026-06-15**.

> Why this file exists: the richest project context (decisions, the current effort, known
> hazards) otherwise lives only in a maintainer's head or local tooling — invisible to a
> fresh checkout, a collaborator, or a cloud review agent. "What the agent can't see
> doesn't exist." Full doc index: [REPO_MAP.md](../REPO_MAP.md).

## Storage re-architecture (the big arc)

Moving the bulk store off `storage.local` — a legacy, effectively O(total-store) JSON
backend on Firefox whose `set` latency was the dominant write-cost ceiling — onto
extension-owned IndexedDB, so every `storage.local` write becomes ~ms. Design pack:
[docs/storage-rearchitecture/](storage-rearchitecture/README.md).

Merged to `main`:

- Step 1 (KV-port) → Step 2 (journal→IDB) → Step 3 (node shards→IDB) → Step 3b
  (undo-history→IDB). `main` now keeps journal, shards, and history in IndexedDB.
- **Data-loss fix (PR #19).** The Step-3 split save (shards→IDB, *then*
  manifest→`storage.local`) was non-atomic, and the orphan sweep could delete
  just-written shards as "orphans" → ~660 nodes lost while dogfooding. Fixed by disabling
  the sweep when the shard store is external.

In flight:

- **PR #21 — Step 4: manifest→IDB** (branch `storage/manifest-indexeddb`). Collapses the
  double-buffered manifest into an atomic IDB save. Once it lands, `storage.local` holds
  only manifest/boot/incident/prefs (~KB) and the per-write ceiling is fully lifted.

Not touched by storage work: the reconciliation path (`getNormalWindows` on
focus/activation) stays environment-bound and load-bearing.

## Open PRs

- **#21** `storage/manifest-indexeddb` — storage Step 4 (above).
- **#20** `feat/restore-tree-replace` — restore-from-export (REPLACE) recovery command.
  Intentionally **kept open, not merged**: recovery insurance, not a feature to ship now.

## Performance posture

App-side latency levers are largely exhausted; the historically dominant factor was
`storage.local.set` latency variance (environment-bound), which the IndexedDB migration
lifts. Every save/load/journal/reconciliation/projection change runs the perf guards —
see the perf rules in [AGENTS.md](../AGENTS.md) and the log in
[PERFORMANCE_NOTES.md](../PERFORMANCE_NOTES.md).

## Recovery / data safety

If a build corrupts the tree, recover by importing a clean portable-tree export on a fixed
build. Do **not** revert the IndexedDB-migration commits — the `storage.local` copies have
been removed, so reverting does not bring data back.
