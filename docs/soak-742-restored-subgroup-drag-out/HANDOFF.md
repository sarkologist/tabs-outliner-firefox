# Handoff: soak red at seed 1301127742 — "truth live window IDs match outline live windows"

**Status:** FIXED. Root cause confirmed with instrumentation; the recommended fix (§6) was
implemented in `src/model/outline.ts` with a regression test in `src/model/outline.test.ts`
(`"reattaches a restored tab subgroup owner natively dragged out to a new window"`). This document
is retained as the design rationale: it explains why `reattachLiveTabsToOwningWindows` takes a
`crossWindowMovedTabIds` set and why the naive skip-removal in §4 must NOT be used. The original
investigation framing below is preserved verbatim.
**Severity:** invariant violation in the generated-trace soak; in the real app the symptom is a
browser window that exists but has no window row in the outline after a specific user action
(details below). Not data loss.
**Scope of the fix:** almost certainly `src/model/outline.ts` only (one function plus a threading
change in one other), plus one new regression test in `src/model/outline.test.ts`.

---

## 1. Reproduce it (deterministic, ~2s)

```bash
GENERATED_TRACE_SOAK=1 GENERATED_TRACE_SEED_COUNT=1 GENERATED_TRACE_BASE_SEED=1301127742 \
  pnpm exec vitest run src/background/controller.test.ts -t "adversarial runtime concurrency"
```

Fails with `Error: truth live window IDs match outline live windows`. The assertion is
`invariantEqual(liveWindowIds(state), truth.liveWindowIds, ...)` at
`src/background/controller.test.ts` (search for the error string). `liveWindowIds(state)` collects
`live.windowId` from every outline node with `kind === "window" && status === "live"`; the truth
model requires one live window **node** per open (non-incognito) runtime window — no exceptions.

At failure: truth = `[59, 60, 61, 62]`, outline = `[59, 60, 61]`. Runtime window **62** has no
window node, even though outline tab node `tab:109` is live with `live: {tabId: 124, windowId: 62}`.

## 2. The triggering user action (step 94 of the trace)

`native move tab 124 to new window 62` — i.e. the user **drags a tab out of its window so the
browser creates a new window for it** (harness op `nativeMoveGeneratedTabToNewWindow`, which emits
`tabs.onDetached` → `tabs.onAttached` → `tabs.onUpdated` (+ focus events), then flushes refreshes).

The dragged tab is special: `tab:109` is a **restored-tab-subgroup runtime owner**:

- `status: "live"`, `restoredFromClosed: true`
- it has at least one child (`tab:117`)
- it sits under a closed ancestor (`window:37`, a closed window at root; `tab:109`'s direct parent
  is `window:52`, a live restored window under `window:37`)

This combination was set up earlier in the trace by step 88 (`outliner restore closed node
window:52`), which restored a closed window as runtime window 59 with `tab:109` (runtime tab 124)
nested inside carrying a child.

## 3. Root cause (verified)

Three functions in `src/model/outline.ts` interact. Line numbers are as of commit `174f739`;
search by name if they drift.

1. **`nearestLiveRuntimeOwnerWindowId`** (~line 2257): walks **up from the node itself**. Rule 2
   fires when the *current* node `isRestoredTabSubgroupRuntimeOwner` (live tab,
   `restoredFromClosed === true`, `childIds.length > 0`) **and** `hasClosedAncestor`. Because the
   walk starts at the node itself, a subgroup owner **always returns its own `live.windowId`** —
   the claim is self-referential and therefore true in *any* window the browser moves it to.

2. **`reattachLiveTabsToOwningWindows`** (~line 2231): skips a live tab when
   `nearestLiveRuntimeOwnerWindowId(state, node.id) === node.live.windowId`. For a subgroup owner
   this is **vacuously true forever** (see 1), so the node is never reattached to any window node.

3. **`removeEmptyLiveContainers`** (~line 395, called from `finishRuntimeReconciliation` at the end
   of `reconcileWithWindows`): reaps live container nodes with no children.

Failure sequence after the drag-out:

- `tabs.onAttached` → controller queues a forced-snapshot refresh → `reconcileWithWindows`.
- Reconcile sees runtime window 62, finds no live window node for it, **creates** `window:62`
  (`runtimeProvenance: "browserCreated"`, empty `childIds`).
- The per-window tab loop finds the existing live node `tab:109` for runtime tab 124 and updates
  its live ref **in place** to `{tabId: 124, windowId: 62}` (existing tabs are not reparented in
  this loop; cross-window fixes are `reattachLiveTabsToOwningWindows`' job).
- `reattachLiveTabsToOwningWindows` skips `tab:109` (self-claim, see 2). `window:62` stays empty.
- `removeEmptyLiveContainers` reaps the empty `window:62`.
- Net result each refresh: tab's live ref says window 62, no window node for 62. Verified with
  instrumentation: a `console.error` in `removeEmptyLiveContainers` printed
  `DIAG-REAP-EMPTY-LIVE-WINDOW window:62 runtimeWindowId: 62 prov: browserCreated` four times
  (once per refresh) in this seed.

## 4. Why you cannot "just fix" the skip (validated dead end — do not repeat)

A prototype was tested that made `reattachLiveTabsToOwningWindows` fall through whenever a live
window node exists for the claimed window and the tab is not a descendant of it:

```ts
// DEAD END — breaks the intended subgroup feature. Do not use.
const owningWindowNodeId = liveWindowNodeIdsByRuntimeId.get(node.live.windowId);
if (nearestLiveRuntimeOwnerWindowId(state, node.id) === node.live.windowId) {
  if (!owningWindowNodeId || isDescendant(state, node.id, owningWindowNodeId)) {
    continue;
  }
}
```

It fixes seed 1301127742 but **breaks these two tests** (run them — they are your guardrails):

- `src/model/outline.test.ts` → `"preserves a restored child-bearing tab subgroup through runtime
  reconciliation"` (~line 2270)
- `src/background/controller.test.ts` → `"keeps a restored Chrome-imported tab subgroup attached
  after runtime refresh"` (~line 39397)

Those tests codify the **intended feature** this mechanism exists for: when a closed child-bearing
tab subgroup is *restored*, the browser opens it in a fresh runtime window; the subgroup node must
**stay nested under its closed ancestors** in the outline. In that flow, `reconcileWithWindows`
also creates a window node for the fresh runtime window, the subgroup owner also keeps it empty,
and `removeEmptyLiveContainers` also reaps it — that reaping is **correct and desired** there.
The outline deliberately models that runtime window without a window node (the subgroup owner *is*
the window's owner; e.g. `closeWindow` finds it via `findRestoredTabRuntimeOwnerNode`).

## 5. The distinguishing signal (this is the key insight)

The intended case and the bug case are byte-for-byte indistinguishable in the *post-reconcile*
state. The only difference is **whether this reconcile pass changed the subgroup owner's
`live.windowId`**:

| | intended (restore) | bug (native drag-out) |
|---|---|---|
| owner's `live.windowId` before reconcile | 50 (set by `restoreNodes`) | 59 |
| runtime says the tab is in | 50 | **62** |
| windowId changed during reconcile? | **no** | **yes** |
| correct behavior | keep nested; let empty window node be reaped | reattach under the new window node |

Semantics: the self-ownership claim ("this restored subtree owns its runtime window") is only
valid for the window the restore put it in. Once the browser moves the tab to a *different*
window, the claim is stale — that window was created/owned by the user, not by the restore.

## 6. Recommended fix

In `reconcileWithWindows` (`src/model/outline.ts`, the per-window tab loop around lines 262–311):
when an **existing** live tab node is updated via `updateLiveTabNode(node, tab, clock.now)`,
detect *before* the update whether `node.live.windowId !== tab.windowId`. If it changed, record
the node id in a local `Set<NodeId>` (e.g. `crossWindowMovedTabIds`). There are two such
`updateLiveTabNode(node, tab, ...)` call sites for existing tabs in that loop (one in the
`existingTabId` branch, one in the reattached-node branch — the `existingTabId` branch is the one
that matters; instrument both if unsure).

Thread that set through `finishRuntimeReconciliation(next)` →
`reattachLiveTabsToOwningWindows(state, crossWindowMovedTabIds)` as an **optional** parameter
(default empty set), and change the skip in `reattachLiveTabsToOwningWindows` to:

```ts
if (
  !crossWindowMovedTabIds.has(node.id) &&
  nearestLiveRuntimeOwnerWindowId(state, node.id) === node.live.windowId
) {
  continue;
}
```

i.e. a tab whose runtime window changed in this very pass may not rely on a self-referential
ownership claim; it falls through to the normal lookup
(`liveWindowNodeIdsByRuntimeId.get(node.live.windowId)`) and is reattached under the
freshly-created `window:62`-style node, which then has a child and survives
`removeEmptyLiveContainers`.

Important details:

- `repairState` also calls `reattachLiveTabsToOwningWindows` (with no runtime evidence available).
  It must keep calling it with the default empty set — repair has no basis to invalidate the
  claim, and must keep honoring it (that is what the two guardrail tests exercise via refresh, and
  what keeps restored subgroups stable across restarts).
- For ordinary (non-subgroup-owner) tabs, membership in `crossWindowMovedTabIds` changes nothing:
  their owner-walk already reports the surrounding window, the equality check already fails when
  the windowId changed, and reattach already runs. The set only neutralizes the **self**-claim.
- The moved subgroup owner's child (e.g. `tab:117`, still in runtime window 59) must remain
  reattachable to *its* window node (`window:52`): its owner-walk goes through the moved parent
  whose claim now reports 62 ≠ 59, so the existing logic reattaches it. Don't add the child to the
  set (its windowId did not change); no extra handling needed, but assert it in the test.
- Do **not** clear `restoredFromClosed` on the moved node as the fix. It is tempting and
  semantically arguable, but that flag also feeds title handling (`runtimeTitleForOutlineTab`),
  close provenance, and the truth model's `liveNodeCanRemainUnderClosedAncestor` allowance —
  side effects you would have to re-validate everywhere. The threading fix is strictly scoped.

## 7. Regression test to add (`src/model/outline.test.ts`)

Model it directly on the existing `"preserves a restored child-bearing tab subgroup through
runtime reconciliation"` test (~line 2270) — same literal state: closed `window:parent` →
restored subgroup `tab:subgroup` (live, `restoredFromClosed: true`, runtime tab 10) → child
`tab:child` (live, runtime tab 11), both in runtime window 50. Then reconcile with runtime truth
that says **tab 10 moved to a new window 60** while tab 11 stays in window 50:

```ts
const reconciled = reconcileWithWindows(restored, [
  { id: 50, incognito: false, focused: false, tabs: [ /* tab 11, index 0, active */ ] },
  { id: 60, incognito: false, focused: true,  tabs: [ /* tab 10, index 0, active */ ] }
], { now: 3000 });
```

Assert:

- a live window node exists for runtime window 60 and survives:
  `Object.values(reconciled.nodes).some(n => n.kind === "window" && n.status === "live" && n.live?.windowId === 60)`
- `tab:subgroup` is live in window 60 and is a descendant of (or directly parented under) that
  window node — **not** under `window:parent` anymore
- `tab:child` is still live in window 50, under a live window node for 50 (reconcile will create
  one for window 50 too, since `window:parent` is closed — or under whatever node owns 50; the
  essential assertions are the window-node-for-60 existence and tab membership)
- the original test (~2270) and the controller test (~39397) still pass **unchanged**

## 8. Validation checklist (run all of these)

```bash
# 1. the target seed now passes
GENERATED_TRACE_SOAK=1 GENERATED_TRACE_SEED_COUNT=1 GENERATED_TRACE_BASE_SEED=1301127742 \
  pnpm exec vitest run src/background/controller.test.ts -t "adversarial runtime concurrency"

# 2. the two guardrail tests still pass
pnpm exec vitest run src/model/outline.test.ts -t "preserves a restored child-bearing tab subgroup"
pnpm exec vitest run src/background/controller.test.ts -t "keeps a restored Chrome-imported tab subgroup"

# 3. the closed-window data-loss regression seeds still pass (fixed in commit dce3d1e — do not regress)
for s in 1968011962 1301127611 1301127651; do
  GENERATED_TRACE_SOAK=1 GENERATED_TRACE_SEED_COUNT=1 GENERATED_TRACE_BASE_SEED=$s \
    pnpm exec vitest run src/background/controller.test.ts -t "adversarial runtime concurrency"
done

# 4. full unit suite + types + build
pnpm test && pnpm run typecheck:test && pnpm run build

# 5. soak batches (each stops at the first failing seed; all should pass)
GENERATED_TRACE_SOAK=1 GENERATED_TRACE_SEED_COUNT=150 GENERATED_TRACE_BASE_SEED=1301127611 \
  pnpm exec vitest run src/background/controller.test.ts -t "adversarial runtime concurrency"
GENERATED_TRACE_SOAK=1 GENERATED_TRACE_SEED_COUNT=150 GENERATED_TRACE_BASE_SEED=1968011962 \
  pnpm exec vitest run src/background/controller.test.ts -t "adversarial runtime concurrency"

# 6. full multi-lane soak
SOAK_SEED=1301127700 SOAK_SEED_COUNT=60 pnpm test:soak
```

Baseline before your change: every command above passes on `main` (174f739) **except** #1 and the
first batch in #5, which fail at seed 1301127742 with this exact error.

## 9. Debugging aids if the recommended fix misbehaves

- Re-add the reap probe in `removeEmptyLiveContainers`:
  ```ts
  for (const id of queue) { const n = state.nodes[id]; if (n && isLiveWindowNode(n))
    console.error("DIAG-REAP-EMPTY-LIVE-WINDOW", id, n.live.windowId, n.runtimeProvenance); }
  ```
  In the failing seed it fires for `window:62` exactly when the bug occurs; after a correct fix it
  must not fire for the drag-out window (it SHOULD still fire for restore-created windows in the
  guardrail tests — that reap is the feature).
- The failure dump's `Recent side effects` → `treeStructureUpdated.updatedNodes` shows the
  stranded owner: a live tab with `restoredFromClosed: true` whose `live.windowId` has no
  corresponding window node in `rootIds`/nodes.
- The trace's step list is printed on failure; the triggering step is always a
  `native-move-tab-new-window` whose moved tab id maps (via the `Runtime cache snapshot` ledger's
  `windowScopes[].tabNodeIdsByRuntimeId`) to a node with `restoredFromClosed: true` and children.

## 10. Context: why this surfaced now

This red pre-dates the closed-window data-loss fix (commit `dce3d1e`) and fails identically
without it; the two are independent. It needs a rare trace shape — restore a closed window whose
inner tab has children (creating a subgroup owner under a closed ancestor), then natively drag
that exact tab out into a new window — roughly 1 in ~1500 seeds. The nightly soak picks a random
base seed, so it appears as an intermittent nightly failure with the error
`truth live window IDs match outline live windows`.
