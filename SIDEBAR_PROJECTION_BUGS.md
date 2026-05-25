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
- Strategy: sidebar projection boundary discovery
- Scenario ids: 17 `psh-*` Playwright discovery scenarios; latest run excluded frozen `PT-001`
- Distinct findings recorded: 3
- Status: hunt in progress; open scenarios frozen for later fix pass; 14 remaining scenarios pass when open repros are excluded

## Finding Index

- Open projection findings: `PT-001`, `PT-002`, `PT-003`

### PT-001 rejected sparse slice leaves viewport blank/no retry

- Status: open
- Found by: `psh-scroll-rejected-slice-recovers-without-second-user-scroll`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-scroll-rejected-slice-recovers-without-second-user-scroll" --reporter=list
```

- Expected: after a `getTreeProjectionSlice` request rejects, the sidebar should request or retry the current viewport slice and repaint without requiring another user scroll.
- Actual: the sparse request count remains `1`, and the scrolled viewport stays blank.
- Evidence: the scenario rejects the first sparse slice after scrolling to row `250`; after idle frames, Playwright observes no retry and no visible row `250`.

### PT-002 non-covering sparse slice can blank a previously covered viewport

- Status: open
- Found by: `psh-stale-covering-window-survives-latest-noncovering-slice`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-stale-covering-window-survives-latest-noncovering-slice" --reporter=list
```

- Expected: once the current viewport is painted from a covering sparse slice, a later non-covering sparse response should be ignored or followed by a new current-viewport request.
- Actual: the later non-covering response replaces the sparse projection and the current viewport becomes empty.
- Evidence: after scrolling near row `260`, the test first resolves a covering slice for rows `240..309`, then resolves another pending slice for rows `700..759`; visible rows become `[]`.

### PT-003 full hydration does not recover a viewport blanked by rejected sparse slice

- Status: open
- Found by: `psh-full-state-broadcast-recovers-after-rejected-slice`
- Repro:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "psh-full-state-broadcast-recovers-after-rejected-slice" --reporter=list
```

- Expected: if a sparse slice fails while full hydration is pending, the eventual full `getState` response should render the scrolled viewport without another user scroll.
- Actual: the viewport remains empty after full-state resolution.
- Evidence: after scrolling to row `250`, rejecting the sparse request, and resolving the delayed full state, Playwright still observes no visible row `250`.
