# Storage Re-Architecture Pack

Date: 2026-06-10. Diagnosed at commit `369c317` (branch `codex/closed-subtree-load-consistency`).

This directory is the deliverable of a root-cause review of the persistence layer, the
data-loss bug, the associated performance regression, and the correctness/performance
pendulum in the workflow. It contains both the diagnosis and step-by-step instructions
to implement the fixes. The instructions are written so that an implementer (human or
model) who has NOT read the rest of the conversation can execute them.

Read in order:

| File | What it is | Audience |
| --- | --- | --- |
| [00-DIAGNOSIS.md](./00-DIAGNOSIS.md) | Root causes of the data-loss bug, why the fix is incomplete, why performance regressed, why the project oscillates between correctness and performance. Evidence with file/line references. | Everyone. Read first. |
| [01-TARGET-ARCHITECTURE.md](./01-TARGET-ARCHITECTURE.md) | The target persistence design (v4: journal + verified snapshot + recovery ladder) that achieves durability and performance at the same time, plus the invariants it enforces and what legacy machinery it deletes. | Reviewer + implementer |
| [02-IMPLEMENTATION-PLAN.md](./02-IMPLEMENTATION-PLAN.md) | Phased, test-first instructions. Phase 0 is independent quick wins that restore the perf budgets and close the worst remaining loss vectors without changing the architecture. Phases 1–4 implement v4. | Implementer |
| [03-WORKFLOW-FIXES.md](./03-WORKFLOW-FIXES.md) | Process changes (gates, budgets, invariant registry, evidence-log hygiene, "definition of fixed") that stop the pendulum from recurring. | Everyone |

Ground rules for any implementer working from this pack:

1. Follow `AGENTS.md`: red-green TDD, feature branches, incremental commits.
2. Never mark a phase done while `pnpm test` or `pnpm perf:runtime-guard` is red.
3. Never loosen a value in `scripts/runtime-perf-budgets.json` to make a phase pass,
   except where a budget change is explicitly specified in the plan.
4. Each phase ends with the verification commands listed in that phase. Run all of them.
5. If reality contradicts this pack (a file moved, a line number drifted, a test name
   changed), trust the code and the stated *intent* of the step, not the line number.
   Line references are against commit `369c317`.
