# Sidebar Remote Projection Rewrite

## Goal

Move the sidebar from "hydrate a full local outline before full use" toward "render and operate as a projection client of the background-owned outline".

The background remains authoritative for full `OutlineState`, runtime reconciliation, persistence, history, export/import, and command validation. Sidebars should own view-local state only: rendered sparse windows, scroll/hover/drop/rename state, and small caches needed for responsive DOM updates.

## Why

Correctness hardening made sparse sidebar state explicit. That fixed partial-tree export/mutation hazards, but it also made full-tree feature readiness depend on full local hydration. With several sidebar documents, whole-tree hydration repeats transport, structured clone, and render/projection work per sidebar.

The target is to keep first paint, hover, and scroll-away bounded by sparse snapshots while progressively moving full-tree features to background-backed requests.

## Non-Goals

- Do not expand the first-paint snapshot beyond 256 rows/nodes.
- Do not reintroduce partial sidebar-local export or mutation.
- Do not make command acknowledgements wait for full persistence.
- Do not remove `getState` until replacement paths cover the old behavior.

## Phases

1. Background-backed export.
   - Export can be available from sparse startup because the background exports from authoritative full state.
   - Sidebar no longer serializes `currentState` for export.

2. Background-backed import.
   - Sidebar can upload a file while sparse; background applies import against authoritative state and broadcasts patches/full fallback.

3. Background-backed search/projection.
   - Search input sends query/window requests to the background and receives bounded result windows.
   - Sidebar remains a virtual projection client instead of building a full search projection locally.

4. Coverage-aware commands.
   - Mutations from fully covered sparse rows can send intents to the background for validation.
   - Incomplete subtree operations use background preflight/scope responses.

5. Eliminate default full hydration.
   - Sidebars request full state only for diagnostic/debug fallback or explicitly broad workflows.
   - Startup settles into sparse row-window operation by default.

## Progress

- 2026-05-26: Branch `codex/sidebar-remote-projection-20260526` created from pushed `main` after landing startup storage-fanout work.
- 2026-05-26: Implemented Phase 1, background-backed export.
  - Added a background `exportTree` request that serializes the authoritative `OutlineState`.
  - Changed sidebar export to call the background instead of serializing sidebar-local `currentState`.
  - Export is enabled once sparse startup has produced a tree; import/search/full-tree controls still wait for full local hydration.
  - Added controller coverage for authoritative export and Playwright coverage that export works before `getState` hydration.
- 2026-05-26: Implemented Phase 2, background-backed import readiness.
  - Kept the existing background `importTree` command as the authoritative mutation path.
  - Changed sidebar import readiness so a sparse startup tree can submit an import without waiting for `getState`.
  - Added Playwright coverage that import sends the parsed portable tree before full hydration.
- 2026-05-26: Implemented the first Phase 3 slice, background-backed sparse search.
  - Extended projection snapshot requests with an optional search query.
  - Built query-aware initial/projection snapshots from the full background `OutlineState`, including collapsed-match paths.
  - Enabled search once the sparse tree exists; sparse sidebars now request bounded search projections instead of waiting for `getState`.
  - Kept full-hydrated sidebars on the existing local search projection path.
- 2026-05-26: Fixed sparse search/clear partial-state pruning.
  - Partial projection snapshots now merge roots and child lists without deleting existing local knowledge unless coverage says the sibling list is complete.
  - Added unit coverage for incomplete search snapshots preserving known siblings.
  - Added browser coverage for searching before hydration, clearing search, and recovering the normal sparse outline without `getState`.
- 2026-05-26: Implemented a Phase 4 sparse rename slice.
  - Covered sparse rows can enter and commit rename while full hydration is still pending.
  - Local edit redraws now re-render the current sparse projection rows instead of invoking the full virtual render path, so no `getState` is needed just to show or clear the rename textbox.
  - Added browser coverage for renaming a covered sparse window during hydration.
- 2026-05-26: Tightened Phase 4 sparse keyboard command guards.
  - Cut/paste buttons were already hidden while the sparse projection was partial; keyboard shortcuts now follow the same policy.
  - Prevented `Accel+X`/`Accel+V` from issuing a local partial-state `moveNode` before full hydration.
- 2026-05-26: Tightened Phase 4 sparse restore preflight.
  - Incomplete sparse window/group restores now require a valid background `analyzeRestoreScope` response.
  - Removed the unsafe fallback that analyzed partial sidebar-local state after a failed or invalid background restore-scope response.
  - Added browser coverage for both invalid-preflight aborts and valid background large-restore confirmation.

## Verification Log

- 2026-05-26: `pnpm test -- src/background/controller.test.ts -t "exports a portable tree from the authoritative background state"`
- 2026-05-26: `pnpm run build`
- 2026-05-26: `pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --grep "exports through the background" --reporter=list`
- 2026-05-26: `pnpm test -- src/background/controller.test.ts`
- 2026-05-26: `pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --reporter=list`
- 2026-05-26: `pnpm perf:sidebar-projection-guard`
- 2026-05-26: `pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --grep "exports through the background" --reporter=list` (failed before Phase 2 gate change)
- 2026-05-26: `pnpm run build`
- 2026-05-26: `pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --grep "exports and imports through" --reporter=list`
- 2026-05-26: `pnpm test -- src/background/controller.test.ts`
- 2026-05-26: `pnpm run build`
- 2026-05-26: `pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --reporter=list`
- 2026-05-26: `pnpm perf:sidebar-projection-guard`
- 2026-05-26: `pnpm test -- src/background/storage-v2.test.ts -t "builds query projection"` (failed before Phase 3 query snapshots)
- 2026-05-26: `pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --grep "exports and imports through" --reporter=list` (failed before sparse search enablement)
- 2026-05-26: `pnpm test -- src/background/storage-v2.test.ts -t "builds query projection"`
- 2026-05-26: `pnpm run build`
- 2026-05-26: `pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --grep "exports and imports through" --reporter=list`
- 2026-05-26: `pnpm test -- src/background/storage-v2.test.ts src/background/controller.test.ts`
- 2026-05-26: `pnpm run build`
- 2026-05-26: `pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --reporter=list`
- 2026-05-26: `pnpm perf:sidebar-projection-guard`
- 2026-05-26: `pnpm test -- src/sidebar/partial-outline-state.test.ts src/background/storage-v2.test.ts src/background/controller.test.ts`
- 2026-05-26: `pnpm run build`
- 2026-05-26: `pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --grep "exports and imports through" --reporter=list`
- 2026-05-26: `pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --reporter=list`
- 2026-05-26: `pnpm perf:sidebar-projection-guard`
- 2026-05-26: `pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-rename-covered-row" --reporter=list` (failed before sparse local edit rendering)
- 2026-05-26: `pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-rename-covered-row" --reporter=list`
- 2026-05-26: `pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --reporter=list`
- 2026-05-26: `pnpm run build`
- 2026-05-26: `pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --reporter=list`
- 2026-05-26: `pnpm perf:sidebar-projection-guard` (initial sandbox run failed to bind the local test server; escalated rerun passed)
- 2026-05-26: `pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-cut-paste-shortcuts" --reporter=list` (failed before keyboard sparse action guard)
- 2026-05-26: `pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-cut-paste-shortcuts" --reporter=list`
- 2026-05-26: `pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --reporter=list`
- 2026-05-26: `pnpm run build`
- 2026-05-26: `pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --reporter=list`
- 2026-05-26: `pnpm perf:sidebar-projection-guard` (passed after retry; prior run exceeded the scroll input queue-delay guard)
- 2026-05-26: `pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-incomplete-restore" --reporter=list` (failed before removing partial restore-scope fallback)
- 2026-05-26: `pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-incomplete-restore" --reporter=list`
- 2026-05-26: `pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --reporter=list`
- 2026-05-26: `pnpm run build`
- 2026-05-26: `pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --reporter=list`
- 2026-05-26: `pnpm perf:sidebar-projection-guard`
