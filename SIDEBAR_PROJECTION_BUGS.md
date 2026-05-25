# Sidebar Projection Bug Hunt

This file records distinct bugs found by deterministic sidebar projection/hydration hunts.

Projection discovery is separate from runtime reconciliation trace hunting. Runtime `RT-*` findings stay in `RUNTIME_TRACE_BUGS.md`; projection findings use `PT-*`.

Run projection discovery with:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --reporter=list
```

Fix passes must satisfy correctness and the hard projection perf gate:

```sh
pnpm perf:sidebar-projection-guard
```

## Last Projection Run

- Completed: 2026-05-25
- Strategy: sidebar projection boundary discovery, followed by viewport-preservation fix pass
- Scenario ids: 20 `psh-*` Playwright discovery scenarios
- Distinct findings recorded: 5
- Status: all recorded projection findings fixed
- Perf gate: `pnpm perf:sidebar-projection-guard` passed: startup-hover `firstPaintMaxMs=10.4`, `sparseHoverActionButtonsMin=3`, `hydrationActionButtonsMin=5`; startup-scroll-away `missingViewportRowsMax=0`, `rowsVisibleMsMax=8`, `hydrationRequestsMax=0`.

## Fix Analysis

- `PT-001` and `PT-002`: sparse slice admission treated any returned slice as renderable and a rejected current request as terminal. The fix only renders sparse slices that cover the current viewport, merges non-covering slices without blanking the visible range, and retries one failed current-viewport request.
- `PT-003`, `PT-004`, and `PT-005`: sparse viewport ownership was lost when full hydration, full broadcasts, or unloaded-row compact patches rebuilt projection state. The fix records user sparse-scroll intent, suppresses one active-tab recenter on hydration/broadcast, preserves an already rendered row window only when it intersects the current viewport, and ignores unloaded-node collapsed deltas.

## Finding Index

- Fixed projection findings: `PT-001`, `PT-002`, `PT-003`, `PT-004`, `PT-005`

### PT-001 rejected sparse slice leaves viewport blank/no retry

- Status: fixed
- Found by: `psh-scroll-rejected-slice-recovers-without-second-user-scroll`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-scroll-rejected-slice-recovers-without-second-user-scroll" --reporter=list
```

- Expected: after a `getTreeProjectionSlice` request rejects, the sidebar should request or retry the current viewport slice and repaint without requiring another user scroll.
- Actual: the sparse request count remains `1`, and the scrolled viewport stays blank.
- Evidence: the scenario rejects the first sparse slice after scrolling to row `250`; after idle frames, Playwright observes no retry and no visible row `250`.

### PT-002 non-covering sparse slice can blank a previously covered viewport

- Status: fixed
- Found by: `psh-stale-covering-window-survives-latest-noncovering-slice`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-stale-covering-window-survives-latest-noncovering-slice" --reporter=list
```

- Expected: once the current viewport is painted from a covering sparse slice, a later non-covering sparse response should be ignored or followed by a new current-viewport request.
- Actual: the later non-covering response replaces the sparse projection and the current viewport becomes empty.
- Evidence: after scrolling near row `260`, the test first resolves a covering slice for rows `240..309`, then resolves another pending slice for rows `700..759`; visible rows become `[]`.

### PT-003 full hydration does not recover a viewport blanked by rejected sparse slice

- Status: fixed
- Found by: `psh-full-state-broadcast-recovers-after-rejected-slice`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-full-state-broadcast-recovers-after-rejected-slice" --reporter=list
```

- Expected: if a sparse slice fails while full hydration is pending, the eventual full `getState` response should render the scrolled viewport without another user scroll.
- Actual: the viewport remains empty after full-state resolution.
- Evidence: after scrolling to row `250`, rejecting the sparse request, and resolving the delayed full state, Playwright still observes no visible row `250`.

### PT-004 full `stateUpdated` broadcast jumps a sparse-scrolled viewport back to active rows

- Status: fixed
- Found by: `psh-state-updated-while-scrolled-to-sparse-window-preserves-viewport`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-state-updated-while-scrolled-to-sparse-window-preserves-viewport" --reporter=list
```

- Expected: after the user scrolls to and paints a sparse slice, a full `stateUpdated` broadcast should preserve the current viewport.
- Actual: the visible rows jump from around row `250` back near the active initial rows.
- Evidence: before the broadcast, Playwright observes row `250`; after the broadcast, `visibleRows` no longer contains row `250` and instead reports rows near `787..`.

### PT-005 unloaded node-state patch collapses/jumps a sparse-scrolled viewport

- Status: fixed
- Found by: `psh-unloaded-title-patch-preserves-visible-sparse-window`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-unloaded-title-patch-preserves-visible-sparse-window" --reporter=list
```

- Expected: a compact `nodeStateUpdated` patch for an unloaded row should not disturb the currently visible sparse slice.
- Actual: after the unloaded title patch, the viewport no longer contains row `250` and jumps to a different partial row range.
- Evidence: before the patch, Playwright observes row `250`; after patching unloaded `tab:900`, visible rows move to roughly `120..`.
