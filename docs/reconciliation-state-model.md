# A principled state model for runtime reconciliation

Status: analysis only (2026-06-12). No code changes. Companion audit: every special-case pass and
decision branch in `src/background/runtime-reconciler.ts` and the decision surface of
`RuntimeFactLedger` (`src/background/runtime-facts.ts`), classified against this model.

## 1. The model (one page)

### 1.1 Three stores, one direction of flow

```
browser events ──┐
snapshots ───────┤──▶  BELIEVED RUNTIME  ──┐
command leases ──┘        (replica)        ├──▶ diff() ──▶ convergence actions ──▶ outline mutations
                                           │                                       browser commands
                       OUTLINE CLAIMS ─────┘
                    (live nodes in OutlineState)
```

- **Believed runtime** `R` — one replica of what we think Chrome's session looks like right now:
  a set of *facts*. It is updated by events, corrected by snapshots, and bootstrapped after an
  MV3 service-worker restart from persisted state + one complete snapshot. Nothing else writes it.
- **Outline claims** `C` — the projection of `OutlineState` onto runtime: every live tab/window
  node claims "tab T exists in window W at position i with shape S". Closed nodes claim nothing,
  but carry *matching annotations* (canonical runtime id, `closedBy`, `restoredFromClosed`).
- **Reconciliation** is a pure function `diff(R, C, leases) -> Action[]`. It owns no state and
  performs no I/O. Actions are the only way runtime truth reaches the outline.

### 1.2 Facts and confidence

A fact is `(subject, field, value, source, confidence, epoch, sequence)`.

- Subjects: `tab(id)` with fields `windowId, index, active, url, title, favIconUrl, openerTabId`;
  `window(id)` with fields `tabOrder, activeTabId, focused, state, provenance, lifecycle`.
- `lifecycle ∈ {live, closing, removed}` — removal is a fact, not a deletion (tombstones).
- `provenance ∈ {saved, restored, browserCreated, commandCreated}` — recorded **once**, at the
  moment the window enters `R` (command ack, restore ack, or first sighting of an unknown id).
- Confidence is per fact, ordered: `complete > partial > eventLocal > staleSuspect`
  (the existing `RuntimeSnapshotConfidence` levels; `staleSuspect` is currently declared but never
  produced — in the model it is what a fact decays to when contradicted, see merge rule 3).
- `epoch` is the existing `scopeGeneration`: bumped whenever installed outline shape changes the
  meaning of runtime ids. `sequence` is the existing per-observation counter.

**Merge rule** (the only update rule `R` has):

1. A new observation wins over an existing fact iff `(epoch, sequence)` is newer **and**
   confidence is sufficient: an `eventLocal` observation may not overwrite a `complete` fact of a
   newer-or-equal sequence; a `complete` snapshot overwrites everything it covers.
2. Snapshot coverage is declared per window: a snapshot that reports a window with an empty/absent
   tab list contributes `partial` facts for that window only (it cannot delete tabs there).
3. An observation that *contradicts* a same-or-higher-confidence fact does not win; it demotes the
   existing fact to `staleSuspect`, which obligates the input layer to fetch a `complete`
   observation before any destructive action touches that subject.

### 1.3 Leases (in-flight commands)

When a command is issued that will cause browser events, it registers a **lease**:
`(ownership, subjects, expected transition, epoch, sequence, TTL-by-contradiction)`. The existing
`CommandTransaction` / `ExpectedRuntimeEffect` machinery is this, half-built. Lease semantics:

- An observation that matches the expected transition is an **echo**: it confirms the lease's
  facts in `R` and produces no actions ("absorb").
- An observation on a leased subject that does *not* match the expectation **breaks the lease**
  (the user did something) and is merged normally.
- Leases carry ownership (`outliner-close | delete | relocation | restore | focus`) so that when
  a subject's `lifecycle` becomes `removed`, `diff` knows *who* removed it and selects the action
  accordingly (mark node closed vs delete node vs do nothing).

### 1.4 Convergence invariants

- **I1 (authority):** `R` is the only source of runtime truth; the outline is never read to decide
  what the browser looks like. (Outline state may seed `R` only at bootstrap, as
  `installedState`-confidence facts.)
- **I2 (pure diff):** every outline mutation caused by runtime is `apply(diff(R, C, leases))`.
  No code path edits the outline from a raw event or raw snapshot.
- **I3 (confidence gate):** destructive actions (delete node, close window subtree) require the
  supporting facts at `complete` confidence; `staleSuspect` facts force a corroborating fetch
  first. Non-destructive actions (metadata, activation) may act on `eventLocal`.
- **I4 (non-live claims are inert):** `diff` may attach a runtime subject to a closed node only
  through declared matching predicates; it may never delete or restructure closed/saved subtrees.
  (This is the invariant the `removeEmptyWindowNodes` data-loss fixes were retrofitting.)
- **I5 (idempotence):** applying the same observation twice yields the same `R`; applying
  `diff`'s actions makes `diff(R, C')` empty when `R` is unchanged.

That is the whole model: a replica with a 3-clause merge rule, leases with 2-clause semantics,
a pure diff, and five invariants. Everything below is audited against it.

## 2. Audit

Buckets: **(a)** becomes a theorem of the model — accidental complexity, disappears in a rewrite;
**(b)** encodes a genuine Chrome/WebExtension runtime quirk — essential, but belongs in the input
layer as a fact recorded once (today it is encoded mid-pipeline, often more than once);
**(c)** fits neither — irreducible special case / product policy the model cannot derive.

### 2.1 Snapshot normalization passes (`RuntimeReconciler.normalizeSnapshot`, applied innermost-first)

| # | Pass / branch | Bucket | Justification |
|---|---|---|---|
| 1 | `filterIgnoredTabsFromWindows` | (a) | Removal tombstones outrank a stale snapshot by `(sequence, confidence)`; merge rule 1 makes the filter a no-op pass. |
| 2 | `filterIgnoredWindowsFromWindows` | (a) | Same theorem at window granularity. |
| 3 | `addMissingTabsForEmptyOpenWindowSnapshots` | (b) | Real quirk — `windows.getAll` can report an open window with an empty tab list mid-teardown/drag; model encodes it as merge rule 2 (per-window `partial` coverage) instead of synthesizing fake `RuntimeTab`s from outline state (which violates I1). |
| 4 | `filterCommandRelocatedStaleTabsFromWindows` | (a) | A snapshot showing a leased tab still in its source window is the lease's expected echo; absorption is lease semantics, incl. the fallback-tab synthesis (the replica already believes the target location). |
| 5 | `addMissingCommandRelocatedTabsFromCurrentState` | (a) | Dual of #4 — lease expectation supplies the believed location until echo or break; no outline read needed. |
| 6 | `filterTransientRestoredWindowPlaceholdersFromWindows` | (b) | Real quirk — session restore materializes `about:blank`/`New Tab` placeholders before navigation commits; belongs as a low-confidence "placeholder" fact on tabs in restore-leased windows. The blank-restore-candidate *budget counting* against outline state is accidental ((a)) — placeholder facts simply lose to any claim match. |
| 7 | `applyActivationOverridesToWindows` | (a) | An `onActivated` event has a higher sequence than the snapshot it races; merge rule 1 applies the override with no special pass. |

### 2.2 Event-echo and evidence decisions (`RuntimeReconciler`)

| # | Branch | Bucket | Justification |
|---|---|---|---|
| 8 | `decideCommandRestoredTabEcho` / `isCommandRestoredAbsorbableTabEvent` | (a) | Restore-lease echo absorption; lease self-clears when the observation contradicts the expectation (lease break). |
| 9 | `isTransientRestoredTabEcho` (`about:blank`/`New Tab` detection) | (b) | Same Chrome restore-placeholder quirk as #6; one input-layer predicate, currently encoded twice (#6 and here). |
| 10 | `decideCommandRelocatedTabEcho` | (a) | Relocation-lease echo absorption from any `fromWindowId`; clears on contradiction. |
| 11 | `commandRelocatedMetadataEvidenceForCurrentScope` ("remapToCurrentScope") | (a) | Per-field facts make this automatic: the event's `url/title` fields merge at their sequence while its stale `windowId` field loses to the newer lease expectation; no evidence rewriting needed. |
| 12 | `decideRuntimeTabEcho` (composition) | (a) | Mechanical composition of #8/#10. |
| 13 | `tabEventMayChangeState` | (a) | A pure `diff` emits nothing for no-op evidence by construction (I5). |
| 14 | `filterEventTabsForReconciliation` | (a) | Composition of tombstone filter + echo decisions + no-op filter — all theorems above. |
| 15 | `eventTabsNeedShapeCorroboration` | (a) | Instance of I3: evidence whose unclaimed fields contradict believed facts is `staleSuspect` and forces a `complete` fetch. |
| 16 | `tabEvidenceConflictsWithCurrentShape` — 8 sub-branches (newer-epoch accepted fact; `kind==="created"`; window mismatch; structurally-fresh + metadata change; accepted-fact structural mismatch; projected-index mismatch; unclaimed `active`/`title`/`url`/`favIconUrl` disagreement) | (a) | All eight are one generic rule: *evidence is trustworthy iff fields it does not claim to change agree with current belief, and claimed fields are not dominated by newer facts*. The branch-per-field form is the accidental encoding. |
| 17 | `classifyMissingLiveTabRemoval` (close-outliner-tab vs delete-tab) | (a) | Lease ownership selects the convergence action for a removal fact (§1.3); the decision table is the lease's `ownership` field, not a special case. |
| 18 | `classifyMissingLiveWindowRemoval` — provenance/ownership fallback chain | (a)+(c) | The *chain* (node marker → scope provenance → node flags → default) is accidental: it exists because provenance lives in four stores (see #33). The underlying **action policy table** — which provenances turn a vanished window into a saved closed shell (`close-window`) vs delete its tabs (`delete-tabs`) — is product policy the model takes as a parameter: **(c)**. |
| 19 | `hasRecentClosedWindowSession` input to #18 | (b) | `sessions.getRecentlyClosed` as a signal that Chrome itself recorded a window close; an input-layer fact feeding the (c) policy table. |
| 20 | `missingLiveTabIdsInOpenWindows` (incl. relocation-echo target-window extension) | (a) | This *is* a fragment of `diff(R, C)` (claims with no believed counterpart); the echo extension is lease expectation already in `R`. |
| 21 | `missingLiveWindowIds` | (a) | Same diff fragment at window granularity. |
| 22 | `missingBrowserCreatedWindowIds` | (a) | Production-dead: referenced only by `runtime-reconciler.test.ts`. Evidence of patch-on-patch accretion. |
| 23 | `mismatchedLiveTabIdsInWindows` | (a) | Diff fragment: believed `windowId` disagrees with claim. |
| 24 | `suspiciousShapeTabIdsInWindows` | (a) | Diff fragment: believed shape disagrees with claim → `staleSuspect` → I3 corroboration. |
| 25 | `orderMismatchedWindowIdsInWindows` | (a) | Diff fragment over the `tabOrder` fact. |
| 26 | `consumeCommandRestoredTabEvent`, `consumeCommandRelocatedStaleTabEvent` | (a) | Production-dead wrappers (unit-test-only); same accretion signal as #22. |

### 2.3 `RuntimeFactLedger` decision surface

| # | Branch | Bucket | Justification |
|---|---|---|---|
| 27 | `classifyWindowClosingTabRemoval` (`wait-for-runtime-window` / `wait-for-remaining-tabs` staging) | (b) | Real quirk — `tabs.onRemoved(isWindowClosing)` arrives per-tab before (and without guarantee of) `windows.onRemoved`; the input layer should coalesce the burst into one `window.lifecycle=removed` fact, after which the staged waiting is a theorem (diff fires when the believed window is actually gone). |
| 28 | `…` `ignore-command-owned` arm of #27; `recordNativeTabRemoved` → `ignore-delete-owned`; `recordNativeWindowRemoved` → `ignore-delete-owned` | (a) | Lease ownership masking expected close echoes. |
| 29 | `recordNativeWindowRemoved` → `ignore-duplicate` | (a) | Idempotent fact application (I5). |
| 30 | Focus fast-path trio: `isCommandFocusActiveUpdateEcho`, `recordNativeTabActivated`/`recordNativeWindowFocused` → `applyFastPath` | (a) | Focus-lease echo confirmation; "fast path" is just the empty/small action set a pure diff produces for an already-believed activation. |
| 31 | `consumeOutlinerCloseSessionEcho` (`echoesToSkip` / `skippedBeforeRemoval` dual counters) | (b)+(a) | Quirk: `sessions.onChanged` is unattributed and unordered w.r.t. `tabs.onRemoved` — that fact is **(b)**, recorded once as "close leases also mask one session-change each". The bidirectional counter compensation is **(a)**: it reimplements sequence ordering by hand. |
| 32 | `isTabIgnoredForRefresh` / `isWindowIgnoredForRefresh` — `id <= reconstructedMaxId && !known` inference | (b) | Quirk: MV3 worker restarts lose memory while Chrome's session-scoped ids stay monotonic; "small unknown id ⇒ pre-restart stale" is an input-layer bootstrap fact. Post-bootstrap, "not in `R` ⇒ doesn't exist" is a theorem (I1). |
| 33 | Window provenance: `browserCreatedWindowIds` + `commandCreatedWindowIds` sets, `node.runtimeProvenance`, `scope.provenance`, `resolveRuntimeWindowScopeProvenance` fallback chain, `runtimeProvenanceForRecoveredWindow`, `seedRuntimeWindowProvenanceFromCurrentState` | (b) | Provenance is a genuine, essential fact — but it is one fact stored in four places with a priority chain to arbitrate them. Model: write `provenance` once at window-entry (§1.2) and the chain plus the seeding helper dissolve. |
| 34 | `structurallyFreshTabIds` (`tabNeedsShapeCorroboration`, `markStructurallyFreshIfShapeChanged`) | (a) | Hand-rolled `staleSuspect`: structural change demotes confidence, obligating corroboration (merge rule 3 + I3). |
| 35 | `tabShapeFacts` / `windowShapeFacts` (`recordSnapshotShapeFacts`, `acceptedTabShapeFact`, …) | (a) | This *is* the believed-runtime replica, half-built — facts with `(source, confidence, scopeGeneration, sequence)` already exist; they are merely not authoritative (the outline is still consulted everywhere, violating I1). |
| 36 | `reconcileWindowScopeActiveTabs` + `syncWindowScopeActiveTabsFromShapeFacts` precedence ladders | (a) | Two ad-hoc reimplementations of merge rule 1 for the `activeTabId` fact, needed only because scope state and shape facts are parallel stores. |
| 37 | `updateWindowScopesFromStateTransition` — five-way tab-order source selection (runtime window > outline-synced > existing scope order > order-affecting candidates > outline order) | (a) | One believed `tabOrder` fact per window, updated by merge rule, replaces the branch tree; the branching exists because order lives in three stores (scope, window fact, outline). |
| 38 | `recordInstalledStateShape` + `installedShapeSignature` → `scopeGeneration` bump | (a) | The model's epoch concept; keep the concept, drop the signature-diffing reconstruction of "did anything change". |
| 39 | `reconstructFromState` (+ canonical-id tombstoning of absent ids) | (b) | MV3-restart replica bootstrap from persisted state + snapshot — essential, input-layer, already roughly in the right place; canonical-id tombstoning is #32's fact applied at bootstrap. |
| 40 | `clearRemovalTombstonesForLiveState` | (a) | Commit of a restore/undo lease updates `lifecycle` facts; explicit un-tombstoning is the manual form of that merge. |
| 41 | `recordCommandRestoredTabs` / `recordCommandRelocatedTabs` (leases inferred by diffing two outline states) | (a) | Leases should be declared by command planning (which knows the intent), not reverse-engineered from state transitions; the lease concept itself is model machinery. |
| 42 | `decideCommandRelocationNativeEcho` (attached/detached/moved) + `clearCommandRelocationEchoIfBrowserMoved` | (a) | Lease echo-absorb and lease-break-on-contradiction, verbatim §1.3 semantics. |
| 43 | `closedRestoreNodeIdsExcludedFromRuntimeAttach` (`closedBy === "outliner"` exclusion) | (c) | Product policy: a node the outliner itself closed must not be auto-reclaimed by a look-alike runtime tab. Not a Chrome quirk, not derivable — a declared matching predicate parameterizing `diff` (I4). |

### 2.4 Controller-resident reconciliation logic (`refreshFromRuntimeNow` and satellites)

| # | Branch | Bucket | Justification |
|---|---|---|---|
| 44 | `corroborateMetadataEventEvidence` — double `tabs.query`, trust the second | (b) | Real quirk: a query issued in an event handler can return the pre-event world. "Reads that follow events must be double-read" is a snapshot-acquisition fact, encoded once. |
| 45 | `noEventSnapshotOrderConflictWindowIds` + `corroborateNoEventSnapshotOrder` | (b)+(a) | Same staleness quirk applied to `tabOrder` (the (b) part is #44's rule); the bespoke conflict detector is a diff fragment, (a). |
| 46 | `corroborateMissingOrMismatchedLiveTabs` — 4 detectors, second snapshot, contradiction arbitration | (b)+(a) | The principle is I3 ("destructive convergence needs `complete`-confidence confirmation") — one rule. The four parallel detector+re-query+compare paths are its accidental, per-symptom encoding. |
| 47 | `inactiveEventInWindowWithoutKnownActiveTab` | (a) | Confidence-gap detection: `R` lacks an `activeTabId` fact for the window, so `eventLocal` evidence is insufficient — I3 again. |
| 48 | `allEventTabsWereRelocatedStaleEchoes` / `…CommandRestoredAbsorbableEchoes` early-returns | (a) | Lease echo absorption short-circuit; pure diff returns the empty action set. |
| 49 | Fast-path gating (`applyRuntimeEventTabsFastPath` when no corroboration needed) | (a) | "Apply small high-confidence diffs directly, snapshot otherwise" is the I3 action gate; the separate planner duplicating reconcile logic is accidental. |
| 50 | Snapshot confidence assignment (`eventLocal` / `complete` / `partial` ternary) | (a) | Embryo of the model's confidence tagging — keep the concept, move it into observation construction. |
| 51 | `preserveClosedSubtreesForRuntimeTransition` guard | (a) | Retrofit enforcement of I4 after `reconcileWithWindows`; in the model, diff cannot emit actions against non-live claims, so the guard is unnecessary by construction. (Source of the 2026-06 data-loss class.) |

**Vestigial:** `staleSuspect` is declared in `RuntimeSnapshotConfidence` but never produced
anywhere — the model's missing fourth confidence level exists in name only. Production-dead
methods: #22, #26.

## 3. Verdict

**Bucket sizes:** of ~45 audited passes/branches, **(a) ≈ 33**, **(b) ≈ 10** (collapsing to ~7
distinct Chrome facts once duplicates are unified: empty-window snapshots, restore placeholders,
window-close event bursts, unattributed session events, post-event query staleness ×2 forms,
monotonic-id/MV3-restart, `getRecentlyClosed` signal), and **(c) = 2**:

1. the provenance×ownership → close-vs-delete **action policy table** (#18), and
2. the **outliner-closed-nodes-don't-reattach** matching predicate (#43).

Both (c) items are small, declarative tables/predicates — parameters of `diff`, not control flow.
The empirical measure of essential complexity in this subsystem is therefore roughly: **seven
input-layer facts plus two policy parameters**. Everything else — the six-pass normalization
pipeline, the echo decision lattice, the four provenance stores, the five-way order-source branch,
the per-symptom corroboration paths — is reconstructible as theorems of a replica with one merge
rule, leases, and a pure diff. Strong corroborating signals that the complexity is accidental:
the replica already half-exists (`tabShapeFacts`/`windowShapeFacts` carry exactly the model's
fact tuple), a pure diff already exists (`reconcileWithWindows` in `src/model/outline.ts`),
`staleSuspect` was named but never implemented, and the subsystem has accreted production-dead
methods.

**The audit supports a scoped rewrite.** The contract boundary holds: the 355 controller-level
tests in `controller.test.ts` drive the system exclusively through the fake WebExtension adapter
(events in, `tabs.query`/`windows.getAll` out) and assert on outline state, broadcasts, and
storage — all above the reconciler. They would survive wholesale replacement of
`runtime-reconciler.ts`, `runtime-facts.ts`, and `runtime-window-scope.ts`. Two scoping caveats:
(1) the rewrite boundary is larger than those three files — `refreshFromRuntimeNow`, the fast
path, and the corroboration helpers inside `controller.ts` are part of the same organism and must
move behind the `diff` interface; (2) the unit tests in `runtime-reconciler.test.ts` sit below
the boundary and are forfeit — acceptable, since the behavior they pin is either re-derived
(bucket a) or re-encoded as input-layer facts with their own tests (bucket b). The riskiest new
obligation is making the replica authoritative across MV3 restarts (I1 + #39), which is exactly
the regime the existing soak and journal infrastructure already exercises.

## 4. Re-audit through the stale-snapshot lens (2026-06-13) — §3 verdict CORRECTED

§3 was too optimistic. Executing the first behavioral step (the fact-merge primitive, step 1b — see
`reconciliation-strangler-step-1-merge-primitive.md` §10) installed a static confidence rank and it
**broke 2 `controller.test.ts` contract traces** plus the named invariant
`runtime-reconciler.test.ts:432` *"keeps installed-state tab order ahead of stale accepted window
shape order."* That falsification motivated a re-audit of bucket (a) specifically for branches that
exist to handle **stale / racy / contradictory** runtime observations. Two independent code reviews
(reconciler cluster + controller corroboration cluster) reached the same conclusion.

**The category error in §3.** §3 classed the corroboration/conflict branches as "theorems of the
model" because a confidence-ranked replica can *react* to staleness (pick the higher-confidence
fact). But it conflated **reacting to staleness** with **detecting staleness**. A static rank
decides *which of two facts wins*; it cannot decide *that a fact is a lie*. Detection requires one
of three things a `(epoch, sequence, confidence)` replica structurally lacks:

1. **Re-query + arbitrate** — `corroborateMetadataEventEvidence` issues a second `tabs.query` and
   trusts it (only verbatim comment, `controller.ts:3478`: *"One query may be the event-local stale
   query result; use the next browser view as the current shape"*). A rank cannot trigger a fresh
   observation.
2. **Compare two equal-confidence observations** — `corroborateMissingOrMismatchedLiveTabs`,
   `noEventSnapshotOrderConflictWindowIds` re-fetch `getNormalWindows` and keep the second only if
   it contradicts the first. Both snapshots are `"complete"`; a rank has nothing to adjudicate with.
3. **Epoch + `changedFields` provenance mask** — `tabEvidenceConflictsWithCurrentShape` rejects an
   event whose *unclaimed* fields disagree with belief (`reconciler` ~1134-1161), and treats a
   newer-epoch held fact as beating an older observation (`acceptedFact.scopeGeneration >
   evidence.scopeGeneration`). The mask and epoch are not fact *values* a value-rank can compare.

**The lynchpin is vaporware.** `staleSuspect` (model merge rule 3, demote-on-contradiction) has
**zero producers** in non-test `src/` — only the type declaration at `runtime-facts.ts:17`. The
"reproduces-free" argument for the whole cluster routed through merge rule 3. So the corroboration
helpers are not *accidental duplication of* the model — they **are** the model's missing rule,
implemented eagerly (re-query now) instead of lazily (demote a stored fact).

### 4.1 Reclassification (bucket a → essential)

| Audit # | Branch | Was | Now | Why |
|---|---|---|---|---|
| 15 | `eventTabsNeedShapeCorroboration` | a | **essential** | Initiates a second observation; not a fact-ranking. |
| 16 | `tabEvidenceConflictsWithCurrentShape` (2a epoch, 2b created-on-known, 2d fresh-flag, 2f/2g unclaimed-mask) | a | **essential** | Epoch + per-event mask detection; orthogonal to confidence. (2c hybrid; 2e free *only* under a correct epoch-aware replica.) |
| 24 | `suspiciousShapeTabIdsInWindows` | a | **essential** | Triggers the snapshot double-fetch + compare. |
| 34 | `structurallyFreshTabIds` (hand-rolled `staleSuspect`) | a | **essential** | Transient distrust state set on every structural event; no fact-value equivalent. |
| 36 | active-tab ladders | a | **essential** | Exactly the divergence 1b produced; outline-authority-over-stale-active. |
| 44 | `corroborateMetadataEventEvidence` (double-read) | b | **essential** | Acquisition discipline ("API lies on first read"); not encodable as a single fact. |
| 45 | `noEventSnapshotOrderConflict` (core) | b+a | **essential** | Two equal-confidence snapshots → re-fetch arbitration. |
| 46 | `corroborateMissingOrMismatchedLiveTabs` (core) | b+a | **essential** | Same; the 4-detector fan-out is the only accidental part. |
| 49 | fast-path gating | a | **essential** | The unclaimed-field conflict predicate *is* the staleness detector. |
| 51 | `preserveClosedSubtreesForRuntimeTransition` | a | **essential in practice** | The 2026-06 data-loss guard; deletable only after *proving* the diff never targets non-live claims. |

Genuinely accidental (audit's (a) stands): the diff fragments (#20-#23, #25), tombstone filters
(#1-#2), no-op/ignored filtering, the confidence-gap case (#47, correctly (a)), and — importantly —
the **fan-out shells** (four parallel detectors in #46; eight per-field branches in #16). Those are
real but *shallow* accidental complexity: collapsing them is a refactor, and it carries the same
regression risk 1b hit, because the mechanism underneath is essential.

### 4.2 Corrected verdict

- **Counts.** The essential set (irreducible policy `c` + essential stale-detection mechanism) grows
  from §3's **2** to roughly **12-15**. The cheaply-removable "accidental" set shrinks from ~33 to
  ~18-20, and what remains is the *fan-out and bookkeeping*, not the reconciliation mechanism.
- **The "clean core" does not exist.** §3 promised a small confidence-ranked core under the mess.
  The core *is* the corroboration machinery; it cannot be replaced by a rank because
  detection-of-staleness ≠ ranking-of-facts, and the rule that was supposed to replace it
  (`staleSuspect`) is unimplemented.
- **A model-rewrite does not cheaply pay off.** The achievable simplification is bounded: collapse
  the accidental fan-out (4 detectors → 1 parameterized pass; 8 field-branches → 1 mask-driven loop)
  while *keeping* the re-query/compare mechanism. That is a contained refactor with real regression
  risk, not a rearchitecture — and it does not shrink the essential surface.
- **Original question revisited.** "Is the complexity mostly accidental?" For this subsystem: **no,
  not mostly.** It is substantially essential, concentrated in stale/racy-observation handling — the
  exact thing that makes the app robust against Chrome's lossy event stream. The §3 estimate was
  inflated by the circularity its own §0 warned about: the model could *describe* the precedence,
  but a faithful reimplementation *broke* it.
