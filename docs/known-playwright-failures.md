# Known local Playwright failures (triage 2026-06-17)

`Status: triage` — as of this triage, **one** test in the **local** `pnpm test:playwright` run is
still red on `main`: the `sidebar-first-paint` parallel-load flake (§1). It is **pre-existing**
(reproduced on clean `main`, unrelated to any in-flight branch) and passes in CI because CI runs
`playwright.ci.config.ts` with `workers: 1`. This note records the triage so the red is *known*, not
mysterious.

The second red triaged here — the `psh-two-sidebars-restored-delete-and-search-stay-independent`
projection regression (§2) — has since been **fixed** (see `PT-039`), and the CI blind spot that hid
it is **closed**: `playwright.ci.config.ts` no longer `testIgnore`s `sidebar-projection-hunt.spec.ts`,
so the deterministic projection suite now runs in CI.

## 1. `sidebar-first-paint` › "exports and imports through the background…" — KNOWN FLAKE

- **Verdict: a full-suite parallel-load flake, not a real failure.** It **passes in isolation**:
  `npx playwright test sidebar-first-paint.spec.ts -g "exports and imports through the background"`.
  It only fails under the default config's parallel workers.
- **Why CI is unaffected:** CI runs Playwright with `workers: 1` (`playwright.ci.config.ts`),
  which removes the parallel-load contention. `sidebar-first-paint.spec.ts` is *not* in the CI
  `testIgnore` list — it runs in CI, serially, and passes.
- **Action: documented as known (not fixed).** A deterministic fix would make first paint wait
  on an explicit state signal instead of a frame-timing assumption; not attempted here because
  the failure only reproduces under parallel load and the test is not CI-gating. To reproduce
  locally, re-run the single test in isolation (green) vs. the whole suite.

## 2. `sidebar-projection-hunt` › `psh-two-sidebars-restored-delete-and-search-stay-independent` — FIXED (was a real pre-existing regression)

**Resolved** — recorded as `PT-039` in
[SIDEBAR_PROJECTION_BUGS.md](../SIDEBAR_PROJECTION_BUGS.md). Kept here for the audit trail.

- **Symptom (was, deterministic):** `#state-count` read `"1 match / 1001 items"`, expected
  `"1 match / 999 items"`. Two sidebars project the same 1001-item tree; sidebar A deletes `tab:2`
  and the background broadcasts a delete patch `["tab:2", "window:20"]` (2 nodes); sidebar B is in
  search mode (`"Tab 900"`) and does not hold those nodes in its sparse projection. B kept the stale
  1001 — it did not apply an out-of-view delete patch to its total item count while in sparse/search
  mode (the search row and A's side were always correct; only B's total was stale).
- **Breaking commit (bisected, confirmed product change):** `a5bb527`
  (`perf(sidebar): instant hover feedback + optimistic closed-node delete`, 2026-06-13). The test was
  added green at `b46d619` (2026-05-27). `a5bb527` touches only `src/sidebar/` (no harness/spec
  change), so the harness is byte-identical across the flip: it passes at `a5bb527^` and fails at
  `a5bb527`. The full `git bisect run` kept *skipping* because the test/webserver setup errored at
  many unrelated intermediate commits; the flip was pinned instead with `git log -S
  isAlreadyAppliedDeletePatch` (the guard `a5bb527` introduced) plus parent/child checkout.
- **Root cause + fix:** the optimistic-delete echo guard `isAlreadyAppliedDeletePatch` absorbed any
  delete patch whose nodes were all absent from local state, skipping the `nodeCount` decrement. For a
  sparse sidebar absence does not imply "already applied", so a first-time out-of-view delete was
  wrongly absorbed. The fix additionally requires that this sidebar recorded deleting those nodes (the
  `deletedNodeRevisionById` ledger). Restores **I-14**. Details in `PT-039`.
- **CI blind spot — now closed:** `playwright.ci.config.ts` previously `testIgnore`d the whole
  `sidebar-projection-hunt.spec.ts`, so this correctness regression was invisible to CI. The suite is
  deterministic (state-based waits) and runs ~1.5 min at `workers: 1`, so it now runs in CI; only the
  timing-variance perf/profile specs remain ignored.
