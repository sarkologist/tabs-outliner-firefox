# Invariants Registry

One numbered entry per invariant the system enforces (see
`docs/storage-rearchitecture/03-WORKFLOW-FIXES.md` W-3). New trace classes in the hunt
guides must cite an `I-n`; guard or assert code defending an invariant should reference it
in a comment (`// I-2: no silent stale fallback`) so later cleanup knows what may be
removed once the invariant is enforced elsewhere; RUNTIME_TRACE_BUGS.md fix entries tag
the invariant they restored.

Each entry: statement, owner mechanism, what enforces/tests it today.

## Storage and durability

- **I-1 — Every acked mutation survives a background restart.**
  Owner: storage (journal-before-ack). Small command deltas append to the v4 journal
  before `commandAck`; heavy deltas (weight > 2,000) intentionally fall back to the
  deferred snapshot save and are exempt until spill markers exist (see Tradeoffs in
  ARCHITECTURE.md). Lifecycle commands additionally write `runtimeLifecycleJournal:v1`
  intents before browser side effects. Enforced by: `controller.test.ts` "I-1:" tests
  (restart-before-save, torn-snapshot crash), lifecycle recovery tests.
  Undo parity: a history-tracked command's journal record carries its undo entry's id
  (`historyEntryId`); startup replay rebuilds missing undo entries from the journal fold
  (`replayJournalWithHistory`), so an acked command stays undoable across the same
  restarts its state change survives. Spilled deltas are exempt (consistent with the
  state-side spill exemption). Enforced by: `controller.test.ts` "I-1: an acked delete
  stays undoable...", `outline-journal.test.ts` replayJournalWithHistory tests.
- **I-2 — A loader never silently returns a state older than the newest acked mutation.**
  Owner: storage. Every non-R0 load outcome records an incident
  (`v4LoadRecovery`, `v3LoadSalvaged`, `staleV2FallbackUsed`, `journalReplay`) and forces
  a fresh full snapshot generation. `bootstrapFromWindows` over stored data records
  `bootstrapSkippedStoredDataPresent`. Enforced by: `storage-v4.test.ts` ladder tests,
  `storage-legacy.test.ts` salvage tests, controller startup-salvage tests.
- **I-3 — Storage consistency is verifiable from storage alone.**
  Owner: storage (shadow paging). A v4 shard is trusted only when its embedded generation
  matches the manifest's `shardGenerations` entry; manifests are double-buffered; no
  multi-key `storage.local.set` atomicity is assumed. Enforced by: `storage-v4.test.ts`
  torn-compaction (R1), forged-generation, and crash/restart property tests.
- **I-4 — Interaction-path persistence work is O(delta).**
  Owner: storage + controller. Command acks append one journal entry (or nothing);
  compaction is O(dirty shards) and runs on the deferred schedule; the boot snapshot is
  debounced off-path. Enforced by: `pnpm perf:runtime-guard` hard counters
  (`saves`, `journalWrites`, `mbStringified`) and the `compaction-after-burst` scenario.
- **I-5 — Compaction is crash-safe at any byte boundary.**
  Owner: storage (copy-on-write shard keys; the previous generation stays loadable until
  the new manifest slot is durably referenced; superseded keys are removed only after the
  set commits). Enforced by: `storage-v4.test.ts` R1/property tests; controller
  crash-mid-compaction I-1 test.
- **I-6 — `bootstrapFromWindows` runs only when storage holds no outline data of any
  version.** Owner: controller startup. Enforced by: "startup never bootstraps over
  stored data" tests and the `bootstrapSkippedStoredDataPresent` incident.

## Model and reconciliation (from ARCHITECTURE.md "Important Invariants")

- **I-7 — Every reachable child id exists in `state.nodes`, and parent/child links agree.**
  Owner: model ops; load-time structural repair (`normalizeLoadedOutlineStructure`)
  restores it for damaged stores and reports counts. Enforced by: model unit tests,
  generated-trace invariant checks.
- **I-8 — `rootIds` order and each `childIds` order define visible outline order.**
  Owner: model. Enforced by: model/projection tests, runtime-order trace assertions.
- **I-9 — Live refs map to current runtime resources after reconciliation.**
  Owner: reconciler. Enforced by: generated Firefox-like trace suites.
- **I-10 — Closed nodes keep enough `restore` data to restore by session id or URL.**
  Owner: model/commands. Enforced by: restore command tests.
- **I-11 — Closed subtrees survive non-destructive runtime transitions.**
  Owner: reconciler; defended in depth by `preserveClosedSubtreesAcrossNonDestructiveTransition`
  (the guard fires a `closedSubtreeGuardRestore` incident when it has to repair).
  Enforced by: the closed-subtree hunt corpus and startup/refresh guard tests.
- **I-12 — Runtime-window scopes are reconstructable from durable state plus a complete
  runtime snapshot.** Owner: runtime fact ledger. Enforced by: restart trace suites.
  (Known gap: RT-252 — command-window provenance lost across abrupt restart in a narrow
  pre-existing race; the event journal closes most of the window.)

## Transport and sidebar

- **I-13 — Command acknowledgements never wait for full persistence or sidebar
  broadcasts.** Owner: controller (REMOTE_PROJECTION_REWRITE.md non-goal). Journal
  appends (one small `set`) are the only awaited durability on the ack path; checkpoint
  flushes run only when a delta was too heavy to journal. Enforced by: guard timing
  budgets, "acks without flushing" controller tests.
- **I-14 — Compact patch application leaves sidebar state equivalent to the next full
  state for the changed surface.** Owner: sidebar patch paths. Enforced by:
  `visible-tree.test.ts`, projection guard, Playwright specs.
- **I-15 — `getState` waits for pending background mutations; sparse-snapshot sidebars
  gate search/export/import/drag/mutating actions until full hydration.**
  Owner: controller scheduler + sidebar. Enforced by: controller scheduler tests,
  sidebar gating tests.
