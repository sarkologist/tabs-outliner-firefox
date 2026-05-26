# Sidebar Projection Hunt Runbook

This is the self-contained procedure for running a sidebar projection hunt. It is written for a fresh agent with no chat history.

Use [SIDEBAR_PROJECTION_HUNT_GUIDE.md](./SIDEBAR_PROJECTION_HUNT_GUIDE.md) as the mutation prompt for current sparse cells, threat model, and coverage targets. Use [SIDEBAR_PROJECTION_BUGS.md](./SIDEBAR_PROJECTION_BUGS.md) only after a projection corpus run, for dedupe and evidence.

## Goal

Find new sidebar projection, hydration, and remote-projection protocol bugs by adding or mutating deterministic Playwright scenarios. A hunt is not a performance loop and not repeated replay of the same `psh-*` corpus. The adversarial work is the agent's active scenario design loop around the Playwright harness.

## Files

- [SIDEBAR_PROJECTION_HUNT_RUNBOOK.md](./SIDEBAR_PROJECTION_HUNT_RUNBOOK.md): procedure, stop rule, commands, and responsibilities.
- [SIDEBAR_PROJECTION_HUNT_GUIDE.md](./SIDEBAR_PROJECTION_HUNT_GUIDE.md): threat model, current coverage, sparse cells, and mutation prompt.
- [tests/playwright/sidebar-projection-hunt.spec.ts](./tests/playwright/sidebar-projection-hunt.spec.ts): deterministic projection hunt harness and `psh-*` scenarios.
- [SIDEBAR_PROJECTION_BUGS.md](./SIDEBAR_PROJECTION_BUGS.md): evidence log. Do not use it as the mutation prompt.
- [REMOTE_PROJECTION_REWRITE.md](./REMOTE_PROJECTION_REWRITE.md): rewrite context and verification log for the background-owned projection model.
- [RUNTIME_TRACE_HUNT_GUIDE.md](./RUNTIME_TRACE_HUNT_GUIDE.md): runtime reconciliation hunt guide. Use it only when a projection symptom appears to reveal a background authority, persistence, or reconciliation bug.

## Non-Negotiable Rules

- Do not read fixed repro histories in `SIDEBAR_PROJECTION_BUGS.md` before proposing mutations.
- Do not mutate fixed `PT-*` regression scenarios during discovery.
- Add or clone neutral `psh-*` scenarios; do not edit a scenario after it produces a new distinct failure.
- If a run reveals multiple distinct projection failures, record all of them before changing the corpus.
- If a failure is a harness or fixture precondition issue, fix the harness/scenario before counting it as a projection finding.
- If a failure is a sidebar/projection invariant violation, freeze the scenario and record a `PT-*` finding.
- Do not fix bugs during a hunt. Finding a bug does not end the hunt by itself; freeze and record it, reset the clean-block count, and keep hunting until the normal stop rules say to stop. Fixes happen only after the hunt has stopped.
- Perf guard is not part of discovery. It is mandatory for the later fix/promote pass.

## Harness Semantics

`pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --reporter=list` runs the deterministic projection corpus once.

The harness installs a fake extension runtime before loading `sidebar/sidebar.html`. Scenarios can:

- delay, resolve, or reject `getTreeProjectionSlice` responses;
- inspect captured projection requests, including `query`, `targetNodeId`, `centerRowIndex`, and `rowLimit`;
- keep full `getState` hydration pending or resolve it at chosen times;
- emit compact `nodeStateUpdated`, `treeStructureUpdated`, and full `stateUpdated` background messages;
- simulate scroll, hover, keyboard, search, show-in-tree, and command clicks;
- assert DOM state, visible row indexes, request counts, sent commands, and page issues.

Useful commands:

```sh
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --reporter=list
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "<psh-id-or-regex>" --reporter=list --workers=1
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --list
pnpm run build
pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --reporter=list
pnpm exec playwright test tests/playwright/sidebar-startup-interaction-profile.spec.ts --reporter=list
pnpm perf:sidebar-projection-guard -- --smoke
pnpm perf:sidebar-projection-guard
```

If the Playwright corpus does not complete, the run is not clean. Fix the scenario, harness, or deterministic wait condition before counting the mutation block. Do not treat timing-only flakes as findings unless the scenario has a state-based assertion that proves a real invariant violation.

## Five-Minute Active Mutation Block

A block is a timed period of active adversarial mutation effort. It is not an add/replay/corpus-review cycle.

One block usually contains multiple cycles like:

1. inspect a sparse cell or sidebar code path;
2. add or clone one or more `psh-*` scenarios;
3. replay the new scenario ids;
4. run the projection corpus;
5. review and dedupe failures;
6. choose the next mutation while the same timer is still running.

A clean block means the whole timed block found no new distinct projection signature. Do not count each replay as a separate clean block.

If a block finds a new distinct projection signature, the block is not clean. Freeze every failing scenario, record every distinct `PT-*` finding, reset the clean-block count to zero, and continue discovery in a new active block. Do not switch to fixing just because a bug was found.

Start a timer for active work. Active work includes:

- reading this runbook, the projection guide, current `psh-*` scenarios, and relevant sidebar/projection code;
- selecting sparse coverage cells;
- designing scenarios or asking proposal scouts for ideas;
- editing or adding Playwright scenarios;
- explicit replay of new scenario ids;
- deduping post-run failures.

Active work excludes:

- waiting for Playwright, `pnpm build`, or perf guard commands;
- idle time;
- browser install/setup delays.

The active timer should be roughly five minutes of thinking/editing/reviewing time. Pause the timer while commands run. Resume the same block after the command finishes.

Stop only after three full five-minute active mutation blocks find no new distinct projection bug. The three clean blocks are counted after the most recent new finding.

## Coverage Accounting

A clean hunt result is not the same thing as complete coverage. Bug yield and coverage are separate facts.

When a sparse target finds nothing, update its coverage status based on the scenarios actually added and run, not on the absence of findings.

Use these labels when updating the projection guide or hunt notes:

- `unsampled`: no meaningful scenario exercises the cell yet.
- `sampled-clean`: one or a few scenarios exercised the cell and found no new signature, but important axes remain untested.
- `moderate`: several qualitatively different scenarios exercise independent axes inside the cell, such as query freshness, target-node freshness, scroll position, coverage metadata, patch visibility, command ack order, hydration state, or multi-sidebar fanout.
- `covered/regression-backed`: the cell has broad discovery coverage and known historical failures are preserved as fixed `psh-*` regressions.

After each clean block, write down both:

- **bug yield:** new signatures, duplicate signatures, or none;
- **coverage movement:** what qualitative axes were newly sampled and whether the cell remains sparse.

## Mutation Temperature Ladder

Use the ladder to avoid staying in one local basin.

- **Rung 0:** start each block with sparse cells from [SIDEBAR_PROJECTION_HUNT_GUIDE.md](./SIDEBAR_PROJECTION_HUNT_GUIDE.md).
- **Rung 1 after one clean active block:** change one major axis: request freshness, query/search state, target-node intent, scroll position, patch kind, coverage completeness, hydration state, or command ack/broadcast order.
- **Rung 2 after two clean active blocks:** combine two or three semantic axes that have not recently been combined, such as stale query response plus show-in-tree target slice plus visible delete patch, or pending full hydration plus keyboard command plus out-of-order sparse scroll response.
- **Temporal heat check before stopping:** at Rung 2, include at least one scenario where clocks disagree across a remote-projection boundary. Prefer user intent, stale slice response, background broadcast, command ack, and follow-up viewport request in conflicting order.
- **Rung 3 after three clean active blocks:** stop the hunt. Do not keep replaying or lightly varying the same basin.

## Subagent Scouts

Use subagent scouts when the environment supports them to improve mutation diversity. They are not required for the hunt to be valid, because a single main agent can perform the same scout roles inline. Whether scouts are separate agents or simulated by the main agent, their responsibility is proposal-only.

The main thread always owns file edits, explicit replay, corpus runs, dedupe, bug-log updates, and the stop condition.

Scout inputs:

- Read this runbook, [SIDEBAR_PROJECTION_HUNT_GUIDE.md](./SIDEBAR_PROJECTION_HUNT_GUIDE.md), current `psh-*` scenarios, and relevant sidebar/projection code for the assigned axis.
- Do not read fixed repro histories in [SIDEBAR_PROJECTION_BUGS.md](./SIDEBAR_PROJECTION_BUGS.md) before proposing mutations.
- Do not edit files, run the corpus, promote scenarios, or record findings.

Scout roles:

- Remote request scout: stale/out-of-order `getTreeProjectionSlice`, query replacement, target-node freshness, failed slice retry, and duplicate request suppression.
- Viewport/DOM scout: scroll jumps, empty viewport, reveal highlight, hover controls, focus, keyboard shortcuts, and visible row coverage.
- Background message scout: compact patches, command ack followed by broadcast, full `stateUpdated`, pending full hydration, multi-sidebar fanout, and partial coverage metadata.

Scout output contract:

```text
- id: <neutral-psh-candidate>
- target axes: <3-6 tags>
- pseudo actions: <Playwright/harness-ish ordered list>
- oracle: <DOM/protocol invariant the scenario should stress>
- novelty: <why this is not just a fixed-basin clone>
- risk: <possible harness/precondition concern, if any>
```

## Main Thread Procedure

1. Preflight when starting a new hunt:
   ```sh
   pnpm run build
   pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --reporter=list --workers=1
   pnpm perf:sidebar-projection-guard -- --smoke
   ```
2. Read this runbook, then read [SIDEBAR_PROJECTION_HUNT_GUIDE.md](./SIDEBAR_PROJECTION_HUNT_GUIDE.md) for current sparse cells.
3. Read current `psh-*` scenarios and harness helpers in [tests/playwright/sidebar-projection-hunt.spec.ts](./tests/playwright/sidebar-projection-hunt.spec.ts). Do not read fixed repro details in [SIDEBAR_PROJECTION_BUGS.md](./SIDEBAR_PROJECTION_BUGS.md) yet.
4. Pick one or two sparse cells and the current temperature rung.
5. Add or clone neutral `psh-*` scenarios with a clear oracle. Prefer protocol-level assertions for `query`, `targetNodeId`, request order, absence of unexpected `getState`, and DOM visibility.
6. Replay new scenarios explicitly:
   ```sh
   pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "<new-psh-ids>" --reporter=list --workers=1
   ```
7. Run the projection corpus once:
   ```sh
   pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --reporter=list --workers=1
   ```
8. If failures occur, inspect the Playwright output and [SIDEBAR_PROJECTION_BUGS.md](./SIDEBAR_PROJECTION_BUGS.md) for dedupe/evidence only after the run. Freeze failing scenarios.
9. Record a mutation block note, including both bug yield and coverage movement.
10. If any new distinct signature appears, record it, keep the failing scenario frozen, reset the clean-block count to zero, and start a new active block. Do not start a fix pass yet.
11. If no new distinct signature appears, continue active mutation work until the block has consumed about five minutes, then increment the clean-block count and raise temperature for the next block. Do not mark the target covered unless the scenarios added real qualitative coverage.
12. Stop only after three complete clean active blocks.
13. Final safety:
    ```sh
    pnpm run build
    pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --reporter=list --workers=1
    pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --reporter=list
    pnpm perf:sidebar-projection-guard
    ```

## Mutation Block Note Template

```md
- Block:
- Active effort:
- Rung:
- Axes changed:
- Remote boundaries crossed:
- New/changed scenario ids:
- Explicit replay result:
- Projection corpus result:
- New signatures:
- Coverage movement:
- Dedupe/result:
```

## Fix Pass Boundary

Bug fixing begins only after the hunt has stopped under the normal hunt rules. Finding a bug is not a stop condition; it resets the clean-block count and keeps discovery alive.

After the hunt stops, propose principled fixes for any open `PT-*` findings. A `PT-*` finding is not fixed until:

- failing scenarios are preserved as regression coverage;
- the focused repro passes;
- related projection/hydration tests pass;
- selected first-paint or startup-interaction tests pass for the changed blast radius;
- `pnpm perf:sidebar-projection-guard` passes, or an accepted budget movement is recorded in [PERFORMANCE_NOTES.md](./PERFORMANCE_NOTES.md);
- [SIDEBAR_PROJECTION_BUGS.md](./SIDEBAR_PROJECTION_BUGS.md) records the fix analysis and verification result.

Common fix-pass commands:

```sh
pnpm run build
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --grep "<fixed-psh-id>" --reporter=list --workers=1
pnpm exec playwright test tests/playwright/sidebar-projection-hunt.spec.ts --reporter=list --workers=1
pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --reporter=list
pnpm exec playwright test tests/playwright/sidebar-startup-interaction-profile.spec.ts --reporter=list
pnpm perf:sidebar-projection-guard
```
