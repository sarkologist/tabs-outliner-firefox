# Repository Instructions

**This file is the single, tool-agnostic source of truth for the project's working
agreements, and it is authoritative — it overrides default assistant behavior (including the
default "commit only when asked").** Policy: keep working-agreement content here;
[CLAUDE.md](CLAUDE.md) and any other agent entry point must point to this file rather than
duplicate it (one source, no drift).

## Start here (map)

New to this repo, or a fresh agent run? **[REPO_MAP.md](REPO_MAP.md) is the full
knowledge-base index** — read the cluster relevant to your task, not everything. Quick
pointers:

- **Architecture / big picture:** [ARCHITECTURE.md](ARCHITECTURE.md). **Invariants the
  system enforces:** [INVARIANTS.md](INVARIANTS.md) (`I-1..I-n`).
- **Touching save/load/journal/reconciliation/projection/patch paths?** Read the perf
  rules below, run the guards, and log in [PERFORMANCE_NOTES.md](PERFORMANCE_NOTES.md).
- **Hunting a bug class?** Use the runbook: runtime →
  [RUNTIME_TRACE_HUNT_RUNBOOK.md](RUNTIME_TRACE_HUNT_RUNBOOK.md), sidebar projection →
  [SIDEBAR_PROJECTION_HUNT_RUNBOOK.md](SIDEBAR_PROJECTION_HUNT_RUNBOOK.md).
- **Git workflow & independent review:** see [Git workflow](#git-workflow) and
  [Independent review](#independent-review) below.

The map is mechanically checked: when you add a doc, add it to `REPO_MAP.md` (the vitest
`docs-index` test and `node scripts/check-docs-index.mjs` fail otherwise).

## Working agreements

- Feel free to challenge assumptions and suggest a better way.
- When working on a new feature, use a feature branch, make incremental commits, and open a pull request to land it; merge to `main` only when the user is satisfied (`main` is protected, so a PR is the only path — see [Git workflow](#git-workflow) below).
- Use red-green TDD for behavior changes: write or update a failing test first, make it pass with the smallest change, then refactor if needed.
- For browser UI behavior, prefer Playwright tests that drive the real built extension/UI with deterministic fixtures. Run them with `pnpm exec playwright test`.
- In Playwright coverage, assert both visible behavior and app/runtime state where practical: DOM/accessibility state, console errors, failed network requests, tree invariants, persisted state, and `tabsOutlinerProfile` traces when relevant.
- Keep browser automation stable and inspectable: use semantic roles or `data-testid` selectors for important controls, capture screenshots for layout-sensitive changes, and avoid timing-only waits when a state or event assertion is available.
- For stateful, event-driven, or interleaving-heavy behavior, add deterministic property-style or generated trace tests that assert invariants across many operation sequences.
- When a bug reaches the user that the suite did not catch, treat the escape as a coverage-gap signal, not just a regression: find the uncovered cell of the operation matrix (or the untested broadcast/patch shape) and add a deterministic property/generated guard over that operation space, so the whole class is caught — not only the reported case. Verify the guard by confirming it fails against the pre-fix behavior. If the faulty unit is trapped in a DOM- or module-state-coupled file (e.g. `sidebar.ts`), extract it into its pure sibling module (e.g. `visible-tree.ts`) so a fast unit/property test can reach it; a behavior-preserving extraction that keeps the existing browser corpus green is the enabler, not a yak-shave.
- When investigating soak failures, treat random soak as complementary to targeted hunts: use the failing seed to expose accidental cross-products, then promote real bugs to frozen regressions or update the broader threat model only if the failure reveals a general architectural gap.
- When oracle-backing a new runtime trace class, state the intended invariant first and add small domain traces with expected behavior before broad generated replay gates. If the PureScript oracle diverges from TS, decide independently whether TS or the oracle is wrong; do not expand the oracle merely to mirror current TS behavior.
- Any change that touches save/load/compaction, journaling, broadcast, reconciliation, projection, or patch paths is performance-relevant **regardless of why it was made** — correctness fixes included. Before committing such a change, run `pnpm perf:runtime-guard` (plus `pnpm perf:sidebar-projection-guard` for sidebar paths) and record the result in `PERFORMANCE_NOTES.md` or the commit message. A red guard blocks the commit: fix the cost or explicitly change the budget per the budget-change contract below — never ship red. (CI independently enforces the guard's hard counters on every PR via `--hard-only`; timing budgets stay a blocking local gate because shared runners are variance-prone.) To reproduce CI's hard-counter check locally, build once and run the script directly: `node scripts/perf-runtime-guard.mjs --hard-only` — this is exactly what [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs. (The `pnpm perf:runtime-guard` wrapper rebuilds first and now also tolerates `pnpm perf:runtime-guard -- --hard-only`; `pnpm perf:sidebar-projection-guard` does **not** accept `--hard-only`.)
- Budget changes to `scripts/runtime-perf-budgets.json` are reviewed contract changes: a budget value may be **loosened** only in a commit whose message starts `budget:` and that contains a `PERFORMANCE_NOTES.md` entry stating the scenario, old/new values, the measured cause, and why the cost is fundamental rather than incidental. "Fix now, re-green later" is disallowed. Adding scenarios and tightening budgets after wins follow the same recorded procedure.
- A perf experiment or fix that changes **save timing or save shape** must also run the storage-fault lane (`pnpm autoresearch:accept -- --lanes storage-faults …`, or its two commands directly) before acceptance — this class of change historically traded crash-loss windows for latency without a gate noticing.
- For performance-related changes, profile or otherwise measure the relevant path before accepting the change. Record the scenario, command/tooling, and before/after numbers or trace observations in the commit, PR notes, or `PERFORMANCE_NOTES.md`.
- When performance work changes algorithmic shape, transport shape, save timing, or runtime/sidebar patch behavior, update the `Current Asymptotics Audit` table in `PERFORMANCE_NOTES.md`, or explicitly note that the table is unchanged.
- Use realistic measurements for performance work. Synthetic `pnpm profile:*` runs are good for repeatability, but if they disagree with manual QA, add or inspect an in-browser `tabsOutlinerProfile` trace before choosing the next target.
- Separate perceived latency from eventual persistence. Prefer visible broadcasts/patches on the interaction path and defer/coalesce full storage saves when correctness allows it.
- Avoid full-state transport and full sidebar renders for small changes. Prefer compact semantic patches (`nodeStateUpdated`, `treeStructureUpdated`, `activeStateUpdated`) and reserve full `stateUpdated` for compatibility or genuinely whole-tree-sized changes.
- Preserve object identity for unchanged outline nodes when practical, filter no-op/stale browser events, and absorb command-owned runtime echoes before they trigger saves, broadcasts, diagnostics, or projection rebuilds.
- When replacing a full render with an incremental patch, audit the side effects that used to happen during `render()`: active-tab scrolling, counters, empty states, rename/drop cleanup, diagnostics scheduling, and virtual-row refresh.

## Git workflow

When making any code change in this repository:

1. **Always commit finished work.** Do not leave changes uncommitted or wait to
   be asked. Use a clear, conventional commit message and end it with the
   standard `Co-Authored-By` trailer.
2. **Always work on a feature branch** — never commit directly to `main`. Branch
   from an up-to-date `main` before starting.
3. **If the working tree is already dirty** with changes you did not just make,
   create a git worktree (`git worktree add <path> -b <branch> main`) and do the
   new work there so it stays isolated from the existing changes.
4. **Open a pull request for all work.** `main` is protected — direct commits and
   pushes are blocked — so every branch lands on `main` through a PR. Open one for
   the work (even small changes); never merge to `main` directly, and merge only
   when the user is satisfied.

Keep unrelated changes on separate branches and in separate commits.

## Independent review

Before opening a pull request for substantive work — and again before asking to
merge after later changes — get an **independent review from `codex-cli`** over
the diff, then act on its findings:

1. Run it non-interactively and read-only (so it cannot edit files), pointed at
   the branch diff. For example:

   ```bash
   codex exec -s read-only -C <repo-or-worktree> \
     "Adversarially review the changes on this branch (run: git --no-pager diff
      origin/main...HEAD). Assess correctness, completeness (other affected code
      paths), edge cases, regression risk, and test adequacy. Rank each finding
      Bug / Risk / Nit with file:line and a suggested fix. Do not modify files."
   ```

2. **Judge each finding on its merits** — codex can be wrong. Verify it against
   the code before acting; fix real issues with a test that fails pre-fix, and
   record why any finding is declined.
3. Note the review outcome and how the findings were resolved in the PR (a
   comment is fine).

Skip only for trivial, mechanical changes (typo, comment, formatting, pure
rename).
