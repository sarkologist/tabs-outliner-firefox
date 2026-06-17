# Project state — what's happening now

A snapshot of in-flight work and current posture that is **not** derivable from `main`'s
code or git history alone. Update this when a PR lands or a new effort starts; keep it
short so it stays cheap to maintain. Last updated: **2026-06-17**.

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
  (undo-history→IDB) → Step 4 (manifest→IDB, PR #21). `main` now keeps journal, shards,
  history, and the manifest in IndexedDB; a normal save writes only to IndexedDB.
- **Data-loss fix (PR #19).** The Step-3 split save (shards→IDB, *then*
  manifest→`storage.local`) was non-atomic, and the orphan sweep could delete
  just-written shards as "orphans" → ~660 nodes lost while dogfooding. Fixed by disabling
  the sweep when the shard store is external.

The migration is **complete** (Step 4, PR #21): the manifest now lives in IndexedDB too, so
a normal save writes only to IndexedDB and `storage.local` retains only the boot snapshot,
incident log, and preferences (~KB). The per-write ceiling is fully lifted.

Not touched by storage work: the reconciliation path (`getNormalWindows` on
focus/activation) stays environment-bound and load-bearing.

## Sidebar posture — remote projection (completed arc)

The sidebar is a **sparse projection client** of the background-owned outline: it renders
bounded row windows and supports export, import, search, rename, and guarded
cut/paste/restore **without full local hydration**. Full `getState` is a fallback for
diagnostics or explicitly broad workflows, not the default. Shipped on `main` 2026-05-26;
design/rationale in [REMOTE_PROJECTION_REWRITE.md](../REMOTE_PROJECTION_REWRITE.md), live
health (the `PT-*` projection hunt; no open findings at last run) in
[SIDEBAR_PROJECTION_BUGS.md](../SIDEBAR_PROJECTION_BUGS.md).

## Open PRs

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
