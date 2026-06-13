# `createBackgroundController` factory map (Track B)

Status: analysis only (2026-06-13). No code changes. Purpose: make the ~5,856-line
`createBackgroundController` factory (`src/background/controller.ts:411–6267`) navigable, and lay
out a *safe* decomposition order. This is Track B's cheap precursor — map before you cut. Companion:
the maintainability rationale and Track A progress are in [[controller-decomposition]] (memory).

Line numbers are as of this writing (after Track A; controller.ts is 6,652 lines total). They drift
— search by symbol name.

## 0. The shape of the fear

The returned `BackgroundController` object is **tiny** (`:6238–6266`): `ensureState`,
`handleMessage`, `refreshFromRuntime`, `flushPendingSaves`, `__debugRuntimeIndexStatus`,
`__debugRuntimeCacheSnapshot`. Everything else (~5,800 lines) is private machinery reachable only
through **`handleMessage`** (the message router) and the **browser event listeners** registered at
construction. So the whole factory is an event-driven state machine with two entry points.

**The single structural obstacle to decomposition** is the shared closure-state block at
`:412–495` — ~70 `let`/`const` bindings that act as an in-scope mutable **bus**. No sub-system can
be lifted out until ownership of the state it touches is assigned. Everything below is organized to
make that assignment possible.

## 1. Mutable state — 12 clusters (~50 factory-level bindings)

Ranked by entanglement (how many functions touch it):

| Cluster | Key bindings | Entanglement | Decl |
|---|---|---|---|
| **Canonical state triad** | `state` (read in **51 fns**), `stateCache`, `runtimeIndex`, `lastPersistedState`, `deferredPersistedStateCloneTimer` | **Highest.** The live-truth substrate. `state`+`stateCache` are redundant holders kept in sync. | :432–447 |
| **Runtime fact ledger** | `runtimeFacts` (`RuntimeFactLedger`, touched in **26 fns**), `runtimeReconciler` | **2nd highest.** Authority on "did the outliner cause this echo." | :429–430 |
| **Save / persistence** | 13 interlocking vars: `pendingSaveState/History/CandidateNodeIds`, `saveTimer`, `saveMaxTimer`, `saveInFlight`, `saveAfterInFlight`, `pendingSaveSchedule`, `saveFailureBackoffIndex`, … | Confined to ~8 `schedule*`/`flush*` fns. **Self-contained.** | :451–480 |
| **Journal / v4 snapshot** | `outlineJournal`, `currentV4Snapshot`, `previousV4Snapshot`, `journalTouchedSinceCompaction`, `pendingEventJournalItems`, event-journal timers | Tight named set. **Self-contained.** | :465–479 |
| **Mutation scheduler** | `highPriorityMutations`, `lowPriorityMutations`, `schedulerRunning`, `schedulerDrainQueued`, idle resolvers | Almost dependency-free queue. **Self-contained.** | :440–446 |
| **Runtime-refresh coalescing** | `pendingRuntimeRefresh`, `sessionChangedQueued`, `pendingSessionChangedCount` | 6 fns. | :448–450 |
| **Lifecycle-journal recovery** | `nextRuntimeLifecycleJournalSequence`, `runtimeLifecycleJournalEntryIdsToClearAfterSave`, `pendingOutlinerCloseJournalEntries` | Connective tissue (command ⇄ native ⇄ boot). | :481–483 |
| **History / undo-redo** | `historyState`, `historyLoadInFlight`, `historyWarmupTimer` | 8 fns. | :435–437 |
| **Sidebar / broadcast / ports** | `sidebarPorts`, `fullSizeOutlinerWindowIds`, `sidebarWindowCreationInFlight`, `pendingSidebarProfileCollections`, `sidebarProfileRequestSequence` | **Lowest.** Transport touches only `sidebarPorts`. | :490–494 |
| **Perf tracing** | `perfTrace`, `performanceTracePreferenceLoaded`, `diagnosticsInFlight`, `automaticBackupInFlight` | Leaf. | :414–489 |
| **Preferences** | `preferences` | Leaf. | :438 |
| **Boot** | `bootSnapshotTimer` (+ `initializeState` is the dominant first-writer of most clusters) | Phase, not cluster. | :464 |

The triad + `runtimeFacts` are coupled at the hinge **`installStateTransition` (`:4524`)**, which
atomically advances `state`, `stateCache`, `runtimeIndex`, and `runtimeFacts` window-scopes
together. That is why they must move as **one unit** (an "outline store" facade), not piecemeal.

## 2. Sub-systems (in order of appearance)

| # | Sub-system | Span (approx) | Owns | Coupling |
|---|---|---|---|---|
| 0 | Construction preamble + shared state block | :412–495 | *all* state | **The bus.** |
| 1 | Boot / init / migration / journal recovery (`ensureState`, `initializeState`, `recoverRuntimeLifecycleJournal*`, `migrateLegacyStateToV4`) | :1762–2734 (+5759–5832) | seeds most clusters | Medium-high; a *phase* (runs once). Extractable as a `StateBootstrapper` returning an initialized bundle. |
| 2 | Runtime-lifecycle journal + side-effect recovery (`recoverOutlinerCloseSideEffect`, `recoverRestoreCreateSideEffect`, …) | :1246–1734 | lifecycle-journal state | **High** — ties command exec, native handlers, boot. Near-core. |
| 3 | Browser event handlers (`tabs.*`/`windows.*`/`sessions.onChanged` listeners + `applyNativeWindowClose`) | :496–829 | session-changed flags, `fullSizeOutlinerWindowIds` | High **fan-out**, low fan-in. Extractable once "classify" is split from "apply". |
| 4 | **Command execution + history** (the `enqueueMutation` body in `handleNonTraceMessage`; `applyHistoryCommand` + replay-reconcile family) | :892–1242 & :2763–3360 | per-command transaction lifecycle | **Maximum.** The hub; embeds per-command-type knowledge. Irreducible core. |
| 5 | Runtime-refresh orchestrator (`refreshFromRuntime[Now]`, fast path `applyRuntimeEventTabsFastPath`, corroboration helpers) | :3362–4489 | `pendingRuntimeRefresh` | High but **thematically cohesive** ("make state match observed runtime"). Largest single sub-system (~1,127 lines). |
| 6 | Message router (`handleMessage` → `handleNonTraceMessage` guard ladder) | :805–892 | nothing | Low **as a router**, but physically *contains* #4's body. Splitting router from command body is a clean first refactor. |
| 7 | Runtime-index cache + `installStateTransition` chokepoint | :4490–4783 | `runtimeIndex`, `lastPersistedState` | Medium; foundational utility called everywhere. The index builders are already extracted ([runtime-state-index.ts](src/background/runtime-state-index.ts)); residue is the install chokepoint. |
| 8 | **Scheduler + persistence/save engine + journal append** | :4843–5862 | scheduler + save + journal state | Internally **most cohesive**; narrow verb set (`scheduleStateSave`, `flushPendingSaves`, `appendCommandJournal`). Excellent extraction target. |
| 9 | **Broadcast to sidebar + ports** (+ diagnostics/perf leaves) | :5120–5160, :5864–6266 | `sidebarPorts` et al. | **Lowest.** Transport takes a finished message, touches only `sidebarPorts`+`perfTrace`. Cleanest seam. |

## 3. Decomposition roadmap (both independent maps agree)

Extract in this order — each step owns a **disjoint state slice**, so it can move behind an
interface without disturbing the core. Same strangler loop as Track A (behaviour-preserving,
typecheck + vitest + soak green, `controller.test.ts` unmodified):

1. **Broadcast / port transport** (#9, ~120 lines core). Owns only `sidebarPorts`; takes a
   fully-formed patch message. No shared-state risk → the safest first cut. Caveat:
   `persistWithBestEffortPatch` (`:5054`) interleaves `broadcast*` with `scheduleStateSave`, so the
   *call sites* are conjoined — but the broadcast *functions* lift cleanly behind a `SidebarBroadcaster`.
2. **Persistence coordinator** (the save engine + outline journal half of #8, :5162–5862) and the
   **mutation scheduler** (:4843–4978). Disjoint, self-contained state slices; narrow verb sets.
   → `PersistenceCoordinator`, `MutationScheduler`.
3. **Only then** push #4's **per-command-type post-processing branches** (:1106–1242) behind a
   strategy interface — without moving the command hub itself.

**Leave in place as the residual heart (irreducible):** the canonical-state triad + `runtimeFacts`
+ `installStateTransition` + command execution (#4) + lifecycle recovery (#2). These compose every
other sub-system and mutate the shared truth through one chokepoint. Trying to "extract" them is the
clean-room rewrite we already ruled out ([[reconciliation-state-model-audit]]).

## 4. What this buys

Fear comes from "I don't know what this 5.8k-line thing holds or what my change will ripple into."
This map answers both: §1 says what state exists and who touches it; §2 says what the sub-systems
are and where they live; §3 says which 3 can be lifted out safely and which core must stay. A
developer can now navigate the factory by sub-system, and the first safe extraction
(`SidebarBroadcaster`) is a ~120-line, single-state-slice move with the test net as backstop —
exactly the low-risk shape Track A proved five times.
