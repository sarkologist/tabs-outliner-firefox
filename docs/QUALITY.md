# Quality scoreboard

Mechanically-tracked debt for this codebase — the solo-scaled version of the
harness-engineering "quality grades per domain" idea. The **rules** are enforced on every
`pnpm test` / CI run; the **numbers** are a snapshot the gardener refreshes (see
[repo-gardening.md](repo-gardening.md)).

The principle: **debt may not be added silently, and is paid down continuously.** Each
ratchet baseline in [`debt-baseline.json`](../debt-baseline.json) may only move DOWN — lower
it when you improve a metric; raise it only as a deliberate, reviewed acknowledgment.

| Metric | Snapshot (2026-06-16) | Rule | Enforced by |
| --- | --- | --- | --- |
| `sidebar → background` imports | 11 | may only decrease; target **0**, then promote to a hard rule | `src/test/debt-ratchet.test.ts` |
| Production `TODO`/`FIXME`/`XXX`/`HACK` | 0 | none may be added | `src/test/debt-ratchet.test.ts` |
| New production files > 1500 lines | 0 new | no new large module (current ones grandfathered) | `src/test/debt-ratchet.test.ts` |
| Module-layer boundaries | clean | `model/` pure; `background/`+`perf/` ↛ UI; sidebar ↛ options (I-16) | `src/test/architecture-boundaries.test.ts` |
| Doc citation integrity | valid | `INVARIANTS.md` cites only files that exist | `src/test/doc-freshness.test.ts` |
| Knowledge-base index | complete | every tracked doc is in `REPO_MAP.md` | `scripts/check-docs-index.mjs` |
| Lint (ESLint, type-aware) | clean | `pnpm lint` green: async-safety (`no-floating-promises`/`no-misused-promises`), exhaustiveness, type-only imports, unused-vars, no-`any` | `eslint.config.js` (folded into `check`) |
| Formatting (Prettier) | clean | `pnpm format:check` green; one-time `prettier --write` reformat applied (recorded in `.git-blame-ignore-revs`) | `.prettierrc.json` (folded into `check`) |

Large production files (grandfathered into `allowedLargeFiles`; trending down via
decomposition — see [controller map](controller-factory-map.md) and
[sidebar map](sidebar-map.md)): `background/controller.ts`, `sidebar/sidebar.ts`,
`model/outline.ts`, `background/runtime-facts.ts`, `background/commands.ts`.

## Paying down

- Removed a `sidebar → background` import? Lower `sidebarToBackgroundEdges`. At 0, flip it
  to a forbidden edge in `architecture-boundaries.test.ts` (it becomes part of I-16).
- Decomposed a large file below the threshold? Drop it from `allowedLargeFiles`.
- The weekly gardener ([repo-gardening.md](repo-gardening.md)) proposes these paydowns; you decide.
