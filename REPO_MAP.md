# Repo map — knowledge-base index

This file is the **table of contents** for the repository's knowledge base. It exists
because the docs are deep but plentiful (~30 files, some very large): an agent or a new
contributor needs a *map*, not a 1,000-page manual. Read the cluster relevant to your
task; you are not expected to read everything.

Conventions used across the docs:

- **Status lines.** Many design docs open with `Status: analysis only` / `scoping only`
  / `FIXED`. Trust that line before acting on the doc.
- **Big files** (flagged 📚 below) are catalogs meant to be **searched**, not read
  end-to-end. `RUNTIME_TRACE_BUGS.md` is ~900 KB; grep it by `RT-`/`SS-` id.
- **Invariants** are numbered `I-1..I-n` in [INVARIANTS.md](INVARIANTS.md); guards, guides,
  and fix entries cite them.
- This index is enforced: `node scripts/check-docs-index.mjs` (and a vitest test) fail if a
  tracked `*.md` is missing here or a link points nowhere. Add new docs here when you
  create them.

## The harness at a glance (deterministic gates)

The repository's enforcement is computational and runs locally + in CI. Before changing
the relevant paths, know which gate covers you:

| Command | What it guards |
| --- | --- |
| `pnpm test` | Unit/contract/property + generated-trace suites (vitest, `src/**/*.test.ts`). |
| `pnpm run typecheck:test` | Tests are type-checked, not just run. |
| `pnpm perf:runtime-guard` | Save/load/journal/reconciliation/broadcast cost budgets. CI enforces the hard counters (`--hard-only`). Budgets live in `scripts/runtime-perf-budgets.json` (a reviewed contract — see [AGENTS.md](AGENTS.md)). |
| `pnpm perf:sidebar-projection-guard` | Sidebar projection/patch cost budgets. |
| `pnpm test:soak` | Randomized generated-operation soak (find accidental cross-products). |
| `pnpm run oracle:build` | PureScript oracle (independent invariant checker) builds. |
| `pnpm test:playwright` | Real built extension/UI behavior + persisted-state assertions. |

## Start here / orientation

- [README.md](README.md) — what the product is: a Firefox sidebar extension for a durable
  outline of live and recently-closed tabs (user-facing).
- [AGENTS.md](AGENTS.md) — repository working agreements and the start-here map; agents
  read this first.
- [CLAUDE.md](CLAUDE.md) — git workflow policy (authoritative; feature branch, always
  commit finished work, worktree if dirty).
- [ARCHITECTURE.md](ARCHITECTURE.md) — current architecture: domain/package layering,
  main design decisions, and tradeoffs. Start here for the big picture.
- [INVARIANTS.md](INVARIANTS.md) — numbered registry of the invariants the system enforces
  (`I-1..I-n`), each with its owner mechanism and what tests/guards defend it.
- [docs/PROJECT_STATE.md](docs/PROJECT_STATE.md) — what's happening *now*: in-flight work,
  storage-migration status, open PRs, and current posture (the context that isn't in
  `main`'s code).

## Task recipes & test harness (last-mile)

The "recipe" layer between ARCHITECTURE's layer model and the source — the exact touch-points
and harness contract for the most common changes, so the last mile is doc-reading, not
source-archaeology.

- [docs/adding-a-command.md](docs/adding-a-command.md) — the concrete site list for adding a
  surface command (mirrors `importTree`), and which sites are compiler-enforced after the
  exhaustive-classification refactor (add the union variant, then let `tsc` walk you to the
  rest).
- [docs/playwright-harness.md](docs/playwright-harness.md) — the sidebar-runtime Playwright
  harness contract (mandatory for browser coverage): real background controller in-process, a
  fake runtime, the page-side `window.browser` *subset* (no `windows.create`), and `load()`'s
  hardcoded sidebar path.

## Repo health & gardening

- [docs/QUALITY.md](docs/QUALITY.md) — the debt scoreboard: the mechanically-tracked
  metrics (boundaries, debt ratchets, doc integrity) and their baselines.
- [docs/repo-gardening.md](docs/repo-gardening.md) — the recurring "garbage collection"
  pass: what the deterministic gates cover, what the scheduled gardener checks by judgment,
  and how it reports (proposes, never automerges).

## Performance (the perf harness)

- [PERFORMANCE_NOTES.md](PERFORMANCE_NOTES.md) — 📚 the performance decision log
  (newest-first), the `Current Asymptotics Audit` table, and budget-change history. Skim
  by section; do not read end-to-end.
- [autoresearch/CORRECTNESS_GUARDS.md](autoresearch/CORRECTNESS_GUARDS.md) — a perf
  experiment may only be kept if the optimized path still passes the relevant correctness
  corpus/lanes; perf counters are not a substitute for correctness.
- Per-scenario local perf-autoresearch programs (fixed metric, fixed run loop):
  - [autoresearch/sidebar-startup/program.md](autoresearch/sidebar-startup/program.md) — initial sidebar loading lag.
  - [autoresearch/sidebar-startup-hover/program.md](autoresearch/sidebar-startup-hover/program.md) — hover responsiveness during startup.
  - [autoresearch/sidebar-startup-scroll-away/program.md](autoresearch/sidebar-startup-scroll-away/program.md) — scroll-away during startup.
  - [autoresearch/sidebar-startup-storage-fanout/program.md](autoresearch/sidebar-startup-storage-fanout/program.md) — boot-snapshot storage fan-out.
  - [autoresearch/sidebar-drag-drop/program.md](autoresearch/sidebar-drag-drop/program.md) — drag-drop interaction cost.
  - [autoresearch/background-reconciliation/program.md](autoresearch/background-reconciliation/program.md) — background reconciliation cost.

## Runtime reconciliation — trace hunting

Deterministic discovery of reconciliation bugs from generated Firefox-like event traces.

- [RUNTIME_TRACE_HUNT_RUNBOOK.md](RUNTIME_TRACE_HUNT_RUNBOOK.md) — **start here to run a
  hunt**: the self-contained procedure (stop rule, commands), written for a fresh agent.
- [RUNTIME_TRACE_HUNT_GUIDE.md](RUNTIME_TRACE_HUNT_GUIDE.md) — the data reference: corpus
  roles, DSL, invariants, threat model, coverage matrix, sparse targets.
- [RUNTIME_TRACE_BUGS.md](RUNTIME_TRACE_BUGS.md) — 📚 catalog of distinct bugs found
  (`RT-*`/`SS-*`). Search by id.

## Sidebar projection / hydration — trace hunting

Separate from runtime reconciliation; covers how the sidebar projects/hydrates the tree.

- [SIDEBAR_PROJECTION_HUNT_RUNBOOK.md](SIDEBAR_PROJECTION_HUNT_RUNBOOK.md) — **start here
  to run a projection hunt**: procedure, stop rule, mutation-block accounting.
- [SIDEBAR_PROJECTION_HUNT_GUIDE.md](SIDEBAR_PROJECTION_HUNT_GUIDE.md) — the mutation
  prompt: current sparse cells, threat model, coverage targets.
- [SIDEBAR_PROJECTION_BUGS.md](SIDEBAR_PROJECTION_BUGS.md) — catalog of projection bugs
  (`PT-*`).
- [REMOTE_PROJECTION_REWRITE.md](REMOTE_PROJECTION_REWRITE.md) — **SHIPPED** (all five
  phases on `main`, 2026-05-26): the design/rationale (goal, non-goals, phase map) for
  moving the sidebar to a sparse projection client of the background-owned outline. Its
  `Progress` log is frozen at the merge; current health lives in `SIDEBAR_PROJECTION_BUGS.md`
  + the projection perf guard.

## Reconciliation state-model work (analysis)

- [docs/reconciliation-state-model.md](docs/reconciliation-state-model.md) — a principled
  state-model audit of `runtime-reconciler.ts` (analysis only; essential vs. accidental
  complexity verdict).
- [docs/reconciliation-strangler-step-1.md](docs/reconciliation-strangler-step-1.md) —
  scoped strangler step: make `activeTabId` a derived fact.
- [docs/reconciliation-strangler-step-1-merge-primitive.md](docs/reconciliation-strangler-step-1-merge-primitive.md)
  — the confidence-merge primitive that step 1 actually needs.

## Code maps (decomposition)

Map-before-you-cut references for the two largest source files.

- [docs/controller-factory-map.md](docs/controller-factory-map.md) — a map of
  `createBackgroundController` to guide a safe decomposition order (Track B).
- [docs/sidebar-map.md](docs/sidebar-map.md) — a map of `sidebar.ts` for UI decomposition.

## Storage re-architecture pack

Root-cause review of the persistence layer and the staged move onto IndexedDB.

- [docs/storage-rearchitecture/README.md](docs/storage-rearchitecture/README.md) — pack
  entry point. Read order:
  - [00-DIAGNOSIS.md](docs/storage-rearchitecture/00-DIAGNOSIS.md) — the data-loss / cost diagnosis.
  - [01-TARGET-ARCHITECTURE.md](docs/storage-rearchitecture/01-TARGET-ARCHITECTURE.md) — the target journal/snapshot design.
  - [02-IMPLEMENTATION-PLAN.md](docs/storage-rearchitecture/02-IMPLEMENTATION-PLAN.md) — the staged plan.
  - [03-WORKFLOW-FIXES.md](docs/storage-rearchitecture/03-WORKFLOW-FIXES.md) — workflow/definition-of-fixed items (`W-n`).
  - [04-STORAGE-WRITE-COST.md](docs/storage-rearchitecture/04-STORAGE-WRITE-COST.md) — the per-write-cost diagnosis and the IndexedDB-migration rationale.

## Incident handoffs

- [docs/soak-742-restored-subgroup-drag-out/HANDOFF.md](docs/soak-742-restored-subgroup-drag-out/HANDOFF.md)
  — worked example of a soak-failure root-cause handoff (seed 1301127742; FIXED). The
  template to follow when a soak red needs an isolated write-up.
