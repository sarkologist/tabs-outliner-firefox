# Reconciliation strangler — Step 1 (re-sequenced): the fact-merge primitive

Status: scoping only (2026-06-13). No code changes yet. Supersedes
[`reconciliation-strangler-step-1.md`](./reconciliation-strangler-step-1.md) as Step 1 — that
doc's `activeTabId` collapse is now the *demonstration* that runs on top of this primitive (see §6).
Companion model: [`reconciliation-state-model.md`](./reconciliation-state-model.md).

## 0. Why this is now Step 1

Executing the `activeTabId` collapse falsified its own premise (that doc, §10): "active" is a
three-store sync whose truth is two-tier (a fresh runtime fact, *else* the persisted `node.active`).
Collapsing it cleanly **is** a confidence-merge — "a fresher/higher-confidence observation wins." That
primitive did not exist, so `activeTabId` could not be the *first* step. It becomes the first
*demonstration* of the primitive instead.

This doc scopes the primitive accurately up front — the lesson from the `activeTabId` doc, which
under-counted its surface ~3×. Here the surface is measured below, not estimated.

## 1. What exists today (measured)

- **~15 fact-write sites, almost all unconditional last-write-wins** `.set()`:
  - tab facts: `runtime-facts.ts:291` (snapshot), `:401` (installedState rebuild), `:705`
    (installedState per-window), `:1166`/`:1174`/`:1209` (`recordInstalledActiveTab` + active
    demotions), `:1220` (tabEvent).
  - window facts: `:318` (`recordWindowShapeFact`), `:380`, `:681`, `:1159`, `:1234`,
    `:1276`/`:1279` (`removeTabFromWindowShapeFact`).
  - deletes: tab `:398`, `:702`, `:732`, `:1625`.
- **`recordWindowShapeFact` (`:308`) is a partial chokepoint** — only 2 of ~7 window writes call it
  (`:270`, `:1514`); the other 4 set the map directly. There is **no** chokepoint for tab facts.
- **The precedence tuple is written but never consumed.** Every fact carries
  `(source, confidence, scopeGeneration, sequence)`, but `.sequence` is **never** compared and
  `.confidence` is read in exactly **one** place (`:423`, `source==="snapshot" &&
  confidence==="complete"`). Today's merge rule is *last write wins*; correctness is held up
  implicitly by the order in which the record\* methods are called.
- **`staleSuspect` is hand-rolled** as the `structurallyFreshTabIds: Set<number>` side-channel
  (~8 internal touch sites: `:220`, `:289`, `:1128`, `:1402-1470`, `:1624`), read via
  `tabNeedsShapeCorroboration` (`:1396`). It has **3 external consumers**:
  `runtime-reconciler.ts:1114`, `controller.ts:3649`/`:3659`/`:3682`.

**Implication.** The merge primitive is largely *greenfield* logic (the precedence rules don't
exist), routed through a chokepoint the codebase mostly lacks. The danger is not breaking existing
precedence — there is almost none — but that *introducing* precedence changes behavior that
currently works by call-ordering accident (see §4).

## 2. Target

One chokepoint per fact kind that every write routes through:

```
mergeTabFact(next: RuntimeTabShapeFact): void      // replaces all tabShapeFacts.set sites
mergeWindowFact(next: RuntimeWindowShapeFact): void // replaces all windowShapeFacts.set sites
```

with a single precedence rule (model merge rule 1):

```
accept `next` over the stored `cur` iff cur is undefined, OR
  rank(next.confidence) >  rank(cur.confidence), OR
  rank(next.confidence) === rank(cur.confidence) && next.sequence >= cur.sequence
where rank: complete > partial > eventLocal > installedState   (staleSuspect handled in §5)
and a newer scopeGeneration (epoch) always wins regardless of confidence.
```

Deletes route through the same chokepoint as tombstones (a removal is a fact, model §1.2). Reads
that need it gain a confidence-aware accessor; most reads stay as-is in this step.

## 3. Internal sub-sequence (strangler *within* the primitive)

This is the part that keeps a high-blast-radius change safe. **Do not** introduce the chokepoint and
the precedence rule in one commit.

- **1a — behavior-preserving chokepoint (zero semantic change).** Add `mergeTabFact`/`mergeWindowFact`
  whose body is *exactly* today's `.set()` (last-write-wins). Route all ~15 sites through them.
  This is a pure refactor: `pnpm test` + `pnpm test:soak` must be green with **no** test edits. It
  establishes the single seam with no risk, and shrinks the diff of every later step.
- **1b — introduce precedence, tightened incrementally.** Put the §2 rule inside the chokepoint,
  but ramp it: first reject only the unambiguously-wrong overwrite (an `installedState` write losing
  to an existing fresher `eventLocal`/`snapshot` fact — the §4 hazard), soak-green, then widen the
  rule until the full §2 ordering is live, soak-green at each tightening. Each tightening is one
  commit; a red localizes to that rule increment.
- **1c — subsume `staleSuspect` (DEFERRED to its own step, not bundled here).** Replace
  `structurallyFreshTabIds` with `confidence:"staleSuspect"` produced on contradiction (merge rule
  3), and switch the 3 external consumers to read confidence. This crosses the
  `runtime-facts.ts` boundary into reconciler + controller, so it is sequenced separately and
  scoped in its own doc when reached.

## 4. The one hazard to call out

`recordInstalledStateShape` (`:401`) rewrites `installedState` tab facts from `node.active` on
**every** `rebuildWindowScopes`, which runs after most state transitions — not just at bootstrap.
Today (last-write-wins) those writes **overwrite** any fresher `eventLocal` fact. Under the §2 rule
(`eventLocal > installedState`) they would **stop** overwriting. That is a real semantic change and
the most likely source of a 1b regression.

Two defensible readings, to be decided empirically in 1b:
1. The rebuild rewrite is a deliberate *reset to current belief* (the outline is authoritative after
   a committed transition) → installedState writes during rebuild should be modeled as a new epoch
   bump or a confidence-equal-or-higher refresh, not a low-confidence observation that loses.
2. The rewrite is exactly the accidental clobber the model wants to eliminate → letting fresh
   eventLocal facts survive rebuild is a *fix*, and any soak red it produces is a latent bug
   surfacing.

1a → 1b ordering exists precisely so this question is answered with the chokepoint already in place
and the soak suite as adjudicator, changing one rule increment at a time.

## 5. Validation gate

Per sub-step, all green:

```
pnpm test           # vitest incl. controller.test.ts (must pass UNMODIFIED — contract boundary)
pnpm test:soak      # node scripts/run-generated-soak.mjs — the precedence adjudicator
pnpm run typecheck:test
```

`pnpm test:playwright` before the final commit (active-tab/order are user-visible). `pnpm check` for
the squashed final. As with Step 1: if a `controller.test.ts` assertion needs editing to pass, that
is a scope violation — stop and treat it as a §7 finding.

## 6. The demonstration: `activeTabId` falls out

Once 1a+1b are green, the `activeTabId` collapse from
[`reconciliation-strangler-step-1.md`](./reconciliation-strangler-step-1.md) becomes a one-liner:
`activeTabIdForWindow(w)` = the live tab in `w` whose merged `tabShapeFact` has `active===true` at
the winning confidence (with `node.active` already represented as the `installedState`-confidence
fact). The two ladders, the `scope.activeTabId` shadow, and the `matchesLiveRuntimeWindows`
equivalence read all collapse onto the merged facts. **That collapse is the acceptance test that the
primitive works** — if it does *not* fall out cleanly, the primitive is wrong, not the demo.

## 7. Kill criteria

- 1a (behavior-preserving) cannot be made green without test edits → a write site has a hidden
  side effect beyond setting the map; document it before proceeding.
- A 1b tightening goes soak-red and green requires consulting `node.active` *inside* the merge (not
  just treating it as an `installedState` fact) → the outline is authoritative in a way the
  confidence model can't yet express; record it as a model gap (bucket c candidate).
- The `activeTabId` demo (§6) does not fall out cleanly on top of a green primitive → the precedence
  rule is mis-specified; revisit §2 before going further.

## 8. Rollback

Each sub-step is one squashed commit on `refactor/reconciler-step1-active-tab` (or a renamed
`…-merge-primitive` branch). Revert is per-commit; 1a reverts to identical behavior by construction.
No storage-format change, no migration — no data-at-rest risk.

## 9. Definition of done (this step = 1a + 1b)

- All ~15 fact writes route through `mergeTabFact`/`mergeWindowFact`.
- The §2 precedence rule is live; `.confidence`/`.sequence` are *consumed*, not just written.
- §5 gate green with `controller.test.ts` unmodified.
- The `activeTabId` demo (§6) lands green as the acceptance test.
- Outcome paragraph appended here and to `reconciliation-state-model.md`; `staleSuspect`
  subsumption (1c) carried forward as the next step.
