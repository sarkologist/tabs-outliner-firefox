# Adding a surface command

`Status: recipe` — the concrete touch-points for the most common change, "add a new
command the UI can dispatch." Read [ARCHITECTURE.md](../ARCHITECTURE.md)'s *Adding Or
Changing Features* for the layer model first; this doc is the last-mile site list.

The reference command throughout is **`importTree`** — grep `importTree` to see every site
in context.

## Two kinds of "command"

1. **A `BackgroundCommand`** — a tree mutation or query that flows through `runCommand`
   (focus / close / restore / move / delete / rename / import / undo / redo / refresh …).
   This is what "add a command" almost always means, and what this recipe covers.
2. **A controller *request* outside the command union** — something that is *not* a tree
   mutation, e.g. open a window or export the tree (`openSidebarWindow`, `exportTree`). These
   do **not** touch the classification sites below. Instead: add a message type + guard in
   [`message-guards.ts`](../src/background/message-guards.ts), a branch in
   `handleNonTraceMessage` in [`controller.ts`](../src/background/controller.ts), and (if it
   opens UI) a `browser.windows.create` call. Mirror `openSidebarWindow` / `exportTree`.

## The touch-points for a `BackgroundCommand` (mirror `importTree`)

The **background classification sites are now compiler-enforced**: after the
exhaustive-classification refactor, every one of them keys off `BackgroundCommand["type"]`,
so the fastest way to add a command is to **add the union variant first, then run
`pnpm run typecheck:test` and let the type errors walk you to each remaining site.** None of
the background sites can be silently forgotten anymore.

All in [`src/background/`](../src/background):

| # | Site | File | Enforced? |
| --- | --- | --- | --- |
| 1 | `BackgroundCommand` union — add the `{ type: "…"; … }` variant. **The source of truth; everything below keys off it.** | `commands.ts` | n/a (this is the definition) |
| 2 | `BACKGROUND_COMMAND_TYPES` — add the type string (gates the runtime `isBackgroundCommand` boundary). | `commands.ts` | ✅ `Record<MissingBackgroundCommandTypes, never>` |
| 3 | `runCommand` switch — implement the command (or fall in with an existing case). | `commands.ts` | ✅ default-less switch, non-`undefined` return |
| 4 | `STRUCTURAL_COMMAND_TYPES` — `true` if it changes tree *shape* (placement/existence), `false` if metadata-only. Drives the save schedule + deferred-placement checkpoint. | `commands.ts` | ✅ `satisfies Record<…, boolean>` |
| 5 | `TRACKABLE_HISTORY_COMMAND_TYPES` — `true` if it should produce an undo/redo entry. The `TrackableHistoryCommandType` union and the runtime guard are *derived* from this table. | `history.ts` | ✅ `satisfies Record<…, boolean>` |
| 6 | `historyLabel` switch — the undo/redo label. **Only reached if the command is trackable** (`true` at #5). | `history.ts` | ✅ default-less switch over the derived union |
| 7 | `runtimeIndexCandidateNodeIdsForCommand` switch — which node ids reconciliation must re-key (`[command.nodeId]`, a seeded set, `undefined` for whole-tree commands like `importTree`, or `[]` for no-ops). | `runtime-state-index.ts` | ✅ `command satisfies never` default |

Not compiler-enforced (no type net — copy `importTree`'s footprint and add a test):

| # | Site | File |
| --- | --- | --- |
| 8 | Dispatch from a surface: wire the control and call `runAndRender({ type: "…", … })`; add enable/disable state if the control gates on tree availability. | `sidebar.ts` (or the relevant UI entry point) |
| 9 | Tests: unit coverage in the relevant `*.test.ts`; for browser behavior use the Playwright harness — see [docs/playwright-harness.md](playwright-harness.md). | `*.test.ts`, `tests/playwright/` |

## Commands that need more than the generic path

- **Bespoke post-command work** (runtime placement, follow-up broadcasts): add an entry to
  `commandFinalizers` in `controller.ts` (a `Partial<Record<BackgroundCommand["type"],
  CommandFinalizer>>`; commands with no entry fall back to `finalizeBestEffort`). Broad
  commands like `importTree` intentionally have **no** finalizer entry.
- **A new model operation**: implement it in `src/model/outline.ts` (the pure domain core)
  and call it from the `runCommand` case — keep mutation logic out of `controller.ts`.

## Why this is safe now

Before the exhaustive-classification refactor, sites #4, #5, and #7 were a plain `||`-chain,
a duplicated predicate, and a `default:`-bearing switch respectively — a missed edit was a
*silent behavior bug*, not a build error. They are now all keyed by `BackgroundCommand["type"]`
and fail to compile until you classify the new command. See
[`commands.test.ts`](../src/background/commands.test.ts)'s *command type classification* block
for the behavior pin.
