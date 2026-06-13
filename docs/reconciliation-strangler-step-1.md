# Reconciliation strangler — Step 1: make `activeTabId` a derived fact

Status: scoping only (2026-06-13). No code changes yet. Companion to
[`reconciliation-state-model.md`](./reconciliation-state-model.md) (the target model + audit).

## 0. Why this doc exists

The audit concluded the reconciliation subsystem's complexity is ~33/45 accidental and supports a
scoped rewrite toward a "believed runtime replica + pure diff + leases" model. But the audit is a
paper exercise: it proves current behavior is *compressible*, not that a principled
reimplementation *reproduces* it on the hard seeds. Before committing to the larger rewrite we run
**one cheap, reversible move that doubles as the empirical test of that bet**: make the replica
(`tabShapeFacts`) authoritative for exactly one fact, delete the parallel store that shadows it,
and require the soak suite to stay green.

If the branch collapses and soak stays green → the model is validated on a real surface and we
proceed to Step 2 with earned confidence. If it fights back → we've found genuine essential
complexity early, for the price of one fact, not a rewrite. **Either outcome is a win.** A red
soak here is not a failure of the experiment; it is the experiment producing its most valuable
result (see §6).

## 1. The fact chosen: `activeTabId` (not `tabOrder`)

Both `activeTabId` (audit #36) and `tabOrder` (audit #37) are facts maintained in a parallel store
(`RuntimeWindowScope`) that shadows `tabShapeFacts`/`windowShapeFacts`. `activeTabId` is the right
*first* cut; `tabOrder` is higher value but belongs in Step 2.

| Criterion | `activeTabId` (#36) | `tabOrder` (#37) |
|---|---|---|
| Fact shape | scalar — one tab id per window | ordered list with positional-insert algebra |
| Merge semantics | "which tab's fact says `active`" = max-by-sequence; trivial | index insertion, prune-missing, ignore-filter, preserve-installed-order |
| Parallel decision sites | 3 **divergent** ladders (see §2) | 5-way source-selection + 2 consumers |
| Blast radius if wrong | wrong sidebar highlight — cosmetic, self-heals on next `onActivated` | wrong tab **order** — misplaced tabs, corrupts projection, doesn't self-heal |
| Already has fact-direct path? | **yes** — line `794` reads `tabShapeFacts.active` directly | partial — consumers still prefer scope order |

`activeTabId` wins on every axis that matters for a *first* step: trivial merge, smallest blast
radius, and a fact-direct computation **that already exists in the codebase** (the smoking gun,
§2). The goal of Step 1 is to validate the pattern cheaply, not to capture the most value — so we
take the safe scalar, not the rich list.

## 2. Current state — the smoking gun

"Which tab is active in window W" is computed **two different ways** today:

1. **Fact-direct (the model's target shape, already present):**
   `windowsFromAcceptedShapeFacts` builds each `RuntimeTab.active` straight from the fact —
   `src/background/runtime-facts.ts:794` → `scopedTabFact.active` when `source !== "installedState"`.
   This is exactly `active(t) = tabShapeFacts[t].active`. It already works.

2. **The `scope.activeTabId` scalar cache**, maintained by **three divergent ladders** plus
   bookkeeping:
   - event write — `RuntimeWindowScopeIndex.upsertLiveTab`, `runtime-window-scope.ts:93-95`
     (set on `active===true`, clear on `active===false`).
   - ladder A — `reconcileWindowScopeActiveTabs`, `runtime-facts.ts:737-778`:
     `fact-active → all-known-inactive → node.active → delete`.
   - ladder B — `syncWindowScopeActiveTabsFromShapeFacts`, `runtime-facts.ts:812-861`:
     `fact-active → all-known-inactive → windowFact.activeTabId → delete`.

   The two ladders **disagree on the fallback** (A falls back to `node.active`; B falls back to
   `windowFact.activeTabId`). That divergence is the accidental-complexity signature: two
   hand-rolled implementations of "merge rule 1" for one scalar, drifting apart. Supporting
   bookkeeping that exists only to keep the field alive: seed on `upsertLiveWindow`
   (`:57`), set on `replaceLiveWindowTabs` (`:146`), compute on `rebuild` (`:303`, `:330`), clear
   on `markTabRemoved`/`markWindowRemoved` (`:223`, `:250`).

`scope.activeTabId` (and `windowShapeFact.activeTabId`) are consumed **only inside
`runtime-facts.ts`** — to populate output (`:383`, `:684`) and as ladder-B's own fallback
(`:850-856`). No consumer in `controller.ts` reads `activeTabId` (verified: only `.tabOrder` is
read there, at `:3892` and `:4245`). The output channel to the outline is the per-tab `active`
boolean → `RuntimeWindow.tabs[].active` → `reconcileWithWindows` → `node.active`. So the scalar
cache is an **internal intermediary**, not part of any external contract. Narrow blast radius,
confirmed by reads.

## 3. Target state

One derivation, no stored scalar:

```
activeTabIdForWindow(W) =
  the tab t with tabShapeFacts[t].windowId === W
  and tabShapeFacts[t].active === true
  and tabShapeFacts[t].source !== "installedState"
  (max by sequence if more than one claims active)
```

This is merge rule 1 applied to the `active` field, computed on read. The `active` field already
lives on `RuntimeTabShapeFact` (`runtime-facts.ts:42`) with `source`/`confidence`/`sequence`, so
no new fact plumbing is required — only deletion of the shadow.

## 4. The change, concretely

Additive first, then delete (keeps every intermediate commit green):

1. **Add** a single private helper `activeTabIdForWindow(windowId): number | undefined` on the
   ledger implementing §3 over `tabShapeFacts`.
2. **Redirect reads:** replace the two output sites that read `scope.activeTabId`
   (`:383`, `:684`) and ladder-B's fallback consumer (`:850-856`) with calls to the helper.
3. **Delete the ladders:** remove `reconcileWindowScopeActiveTabs` (`:737-778`) and the
   active-tab half of `syncWindowScopeActiveTabsFromShapeFacts` (`:830-859`); keep that method's
   order-sync half (that's `tabOrder`, Step 2's problem — leave it alone).
4. **Remove the field:** delete `activeTabId` from `RuntimeWindowScope` (`runtime-window-scope.ts:17`)
   and every write site listed in §2 (`:57`, `:93-95`, `:146`, `:223`, `:250`, `:303`, `:330`).
   The TypeScript compiler enumerates the remaining references — follow them to zero.
5. **Window fact:** keep `RuntimeWindowShapeFact.activeTabId` for now **only if** a persisted
   consumer needs it; the audit expects it to become derivable too. If `tsc` shows it is only
   written and never read after step 2, delete it in this same step.

Estimated surface: ~3 deletions (2 ladders + 1 field) and ~3 read-site redirects, all within
`runtime-facts.ts` + `runtime-window-scope.ts`. No `controller.ts` change expected (no consumer
there). No test-contract change expected (output channel unchanged).

## 5. Validation gate

Run in this order; **all must pass** for Step 1 to count as "model validated":

```
pnpm test          # vitest — incl. controller.test.ts (355 contract tests; ~1760 active-tab assertions)
pnpm test:soak     # node scripts/run-generated-soak.mjs — the seed replays that find the hard cases
pnpm test:playwright   # sidebar specs — active-tab highlight is user-visible here
pnpm run typecheck:test
```

`pnpm check` runs the full bundle (`oracle:build && test && typecheck:test && build`) for the final
commit. The contract tests in `controller.test.ts` drive everything through the fake adapter and
assert on outline state — they sit **above** this change and must pass **unmodified**. If a
controller test needs editing to go green, that is a scope violation: stop and treat it as a §6
finding.

## 6. Kill criteria — what "the model fights back" looks like

Step 1 has falsifiable failure modes. If any occur, **stop and record the finding in
`reconciliation-state-model.md` rather than patching around it** — this is the essential-complexity
signal the experiment exists to surface:

- A soak seed goes red that was green before, and making it green **requires** information not
  present in `tabShapeFacts` (e.g. an ordering or focus subtlety the scalar can't express). →
  Promote that to a bucket-(b) input-layer fact or a bucket-(c) policy item; the audit
  under-counted essential complexity.
- A `controller.test.ts` assertion can only pass by reintroducing one of the deleted ladders'
  fallbacks. → The two ladders diverged for a *reason*; document which fallback is load-bearing
  and why.
- The helper needs to read outline `node.active` (not just facts) to match current behavior. →
  Invariant I1 (authority) is violated somewhere upstream; the replica isn't actually
  authoritative for `active` yet, which reshapes Step 2/3.

A clean green across §5 is the positive result: one merge rule replaced two divergent ladders and
a shadow field, with zero contract or soak regression.

## 7. Rollback

Single-purpose branch, one squashed commit. Revert = `git revert` of that commit; nothing else
depends on it because the output channel (`RuntimeTab.active`) is unchanged. No storage-format
change, no migration, so no data-at-rest risk.

## 8. Definition of done

- `scope.activeTabId` field and both active-tab ladders deleted.
- "Active tab" computed in exactly one place, from `tabShapeFacts`.
- §5 gate green, with `controller.test.ts` **unmodified**.
- One paragraph appended to `reconciliation-state-model.md` recording the outcome (validated, or
  the §6 finding).

## 9. Explicitly out of scope (later steps)

- `tabOrder` collapse (audit #37) — Step 2. Richer merge, bigger blast radius; do it once the
  pattern is proven here.
- `staleSuspect` implementation (audit #15/#24/#34/#46) — Step 2, the confidence-decay mechanism.
- `diff → Action[]` extraction behind the controller boundary (audit #44–#51) — Step 3, net-new
  action layer; `reconcileWithWindows` is today a pure *reducer* (`→ OutlineState`), not an
  action emitter.
- Provenance-store unification (audit #33) and the two bucket-(c) policy tables — not part of the
  replica-authority track.

## 10. Execution outcome (2026-06-13): premise falsified — re-sequence before coding

Executed the investigation phase on branch `refactor/reconciler-step1-active-tab`. Baseline
`pnpm test` green. **No source changed** — the read-through falsified the step's scoping premise
before any edit, which is the cheapest possible form of the §6 result.

What the code actually shows (vs. §2's two-representation model):

1. **Three stores, not two.** Active lives in `tabShapeFacts[t].active` (per-tab),
   `windowShapeFacts[w].activeTabId` (per-window, **persisted**), *and* `scope.activeTabId`
   (shadow) — kept in sync by ~10 maintenance sites, not the ~5 §2 listed. `windowShapeFact`'s
   scalar is part of the persisted replica/output, so removing the shadow does not reduce to three
   redirects.
2. **Two-tier truth — §6 kill criterion hit verbatim.** The active tab is "a fresh
   `tabEvent`/`snapshot` fact, else the persisted `node.active`." The command/state-transition
   path (`updateWindowScopesFromStateTransition`, `runtime-facts.ts:624`) computes active *only*
   from `node.active`, consulting no fact. Line `794` and ladder A (`:771-773`) both fall back to
   `node.active`. So the derivation **must** read `node.active`, not just facts → the documented
   kill criterion "helper needs `node.active`" → invariant I1 is not yet satisfiable for `active`.
3. **Unanticipated consumers.** `matchesLiveRuntimeWindows` (`runtime-window-scope.ts:195`) reads
   `scope.activeTabId` for a believed-vs-snapshot **equivalence check** (a scope-index method with
   no access to `tabShapeFacts`); and the event hot-path `recordAcceptedRuntimeTabScopeUpdates`
   (`:1206-1218`) already contains a hand-rolled prior-active **demotion** — i.e. a merge rule.

**Conclusion: Step 1 and Step 2 are mis-ordered.** Collapsing `activeTabId` cleanly *is* a
confidence-merge ("fresh fact beats `installedState`/node belief beats nothing"). That primitive is
what the doc deferred to Step 2 (`staleSuspect` + merge rule). Doing `activeTabId` first does not
*remove* the hand-rolled merge — it copies the two-tier rule to every read site and reimplements
the demotion logic. The genuinely cheap, principled version only exists *after* the merge primitive
does.

**Recommended re-sequence:** build the confidence/belief-merge primitive first (former Step 2 —
make `tabShapeFacts` mergeable by `(source-confidence, sequence)`, with `node.active` entering as an
`installedState`-confidence fact at bootstrap, and `staleSuspect` produced on contradiction). Then
`activeTabIdForWindow(w) = highest-confidence active fact in w` is a one-line consequence, the two
ladders and the shadow field delete cleanly, and `matchesLiveRuntimeWindows` derives from the
merged facts. Net: the merge primitive becomes the new Step 1; `activeTabId` collapse becomes its
first *demonstration*, not its prerequisite.

This is the experiment paying off: a static, pre-code discovery that the plan's ordering was wrong,
for the price of a careful read.
