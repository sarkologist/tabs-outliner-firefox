# Known local Playwright failures (triage 2026-06-17)

`Status: triage` — two tests in the **local** `pnpm test:playwright` run are red on `main`.
Both are **pre-existing** (reproduced on clean `main`, unrelated to any in-flight branch), and
**neither is caught by CI**: CI runs `playwright.ci.config.ts`, which sets `workers: 1` and
`testIgnore`s the projection-hunt + perf/profile specs. This note records the triage so the
reds are *known*, not mysterious.

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

## 2. `sidebar-projection-hunt` › `psh-two-sidebars-restored-delete-and-search-stay-independent` — REAL PRE-EXISTING REGRESSION

- **Symptom (deterministic):** `tests/playwright/sidebar-projection-hunt.spec.ts:8549` —
  `#state-count` reads `"1 match / 1001 items"`, expected `"1 match / 999 items"`.
- **What it exercises:** two sidebars project the *same* background tree (1001 items). Sidebar A
  deletes `tab:2`; the background broadcasts a delete patch `["tab:2", "window:20"]` (2 nodes).
  Sidebar B is in search mode (`"Tab 900"`). B should keep its search result **and** drop its
  total count to 999. It keeps the stale 1001 — i.e. **sidebar B does not apply an out-of-view
  delete patch to its total item count while in sparse/search mode** (the search row and A's
  side are correct; only B's total count is stale).
- **It is a regression, not an aspirational hunt test.** The test was added **green** in
  `b46d619` (2026-05-27) and *passes at that commit*; it is red at `main` (`5e4916d`). A
  regression therefore landed in the **233 commits** in `b46d619..5e4916d`.
- **Why CI is green anyway — worth flagging on its own:** `playwright.ci.config.ts` `testIgnore`s
  `sidebar-projection-hunt.spec.ts` (it is treated as a local-only hunt suite), so a regression
  in a real correctness spec is invisible to CI. Consider either running the hunt spec in CI
  (it is deterministic) or moving a representative two-sidebars independence case into a
  CI-run spec.
- **Bisect bounds for whoever picks this up:**
  `git bisect start 5e4916d b46d619`, then `git bisect run` a script that builds and runs
  `npx playwright test -g "psh-two-sidebars-restored-delete-and-search-stay-independent"`.
  Caveat: the hunt-harness helpers (`loadLargeSparseSidebar`, `emitDeletePatch`,
  `projectionHuntApi`) also evolved across those commits, so confirm the flip is a *product*
  change, not a harness change, at the pinpointed commit.
- **Scope:** out of scope for the onboarding-friction fixes (a projection-domain regression in
  the most intricate subsystem); flagged for the projection owner — see
  [SIDEBAR_PROJECTION_HUNT_RUNBOOK.md](../SIDEBAR_PROJECTION_HUNT_RUNBOOK.md) and
  [SIDEBAR_PROJECTION_BUGS.md](../SIDEBAR_PROJECTION_BUGS.md).
