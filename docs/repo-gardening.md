# Repo gardening (the "garbage collection" cadence)

A recurring, low-ceremony pass that keeps this agent-legible, solo-maintained, gated
codebase from drifting — the solo-scaled version of the harness-engineering *garbage
collection* idea. Technical debt is a high-interest loan: pay it down continuously in small
increments rather than letting it compound into a painful sweep.

## Regime (read first)

This repo is **solo, heavily gated, and data-loss-critical** — the opposite of a
high-throughput agent fleet. So the gardener **proposes; a human decides.** It never
auto-applies risky changes, never automerges, and respects every existing gate (perf
guards, the PureScript oracle, soak). Keep each suggestion reviewable in under a minute.

## What runs automatically (deterministic — the gardener need not re-check these)

These already fail `pnpm test` / CI, so drift in them can't be added silently:

- **Debt ratchets** — `src/test/debt-ratchet.test.ts` + [`debt-baseline.json`](../debt-baseline.json).
- **Module-layer boundaries** — `src/test/architecture-boundaries.test.ts` (I-16).
- **Doc-index completeness** — `scripts/check-docs-index.mjs` (every tracked doc is in `REPO_MAP.md`).
- **Doc citation integrity** — `src/test/doc-freshness.test.ts` (`INVARIANTS.md` cites only files that exist).

## What the gardener checks (semantic — needs judgment)

1. **Doc/code consistency.** Do `Status: analysis only` / `scoping only` docs still match
   the code? Are the map docs' *descriptions* (not their historical line numbers) accurate?
2. **Stale state.** Is [`PROJECT_STATE.md`](PROJECT_STATE.md) current (in-flight PRs,
   migration status)? Flag `Status:` docs older than ~90 days that describe shipped work.
3. **Dead weight.** `profile:*` scripts or `autoresearch/*` programs targeting removed
   paths; exported symbols with no remaining importer; untracked debris left in a worktree.
4. **Debt trend.** Can any [`debt-baseline.json`](../debt-baseline.json) number be
   **lowered** (paid down)? If `sidebarToBackgroundEdges` reaches 0, propose promoting it to
   a forbidden edge in `architecture-boundaries.test.ts`.
5. **Scoreboard.** Refresh the snapshot/date in [`QUALITY.md`](QUALITY.md).

## How to report

Open **one** issue titled `Repo gardening: <YYYY-MM-DD>` with a short, prioritized list.
Where safe, attach a tiny proposed diff or spin off a task. Never open large refactor PRs;
never automerge. Escalate only what needs a human call.

## Cadence

A weekly scheduled cloud routine runs this pass (managed via `/schedule`); it can also be
run on demand. The routine's prompt is just "follow `docs/repo-gardening.md`" — so this
file, version-controlled here, is the single source of truth for what gardening means.
