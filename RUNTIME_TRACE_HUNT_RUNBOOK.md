# Runtime Trace Hunt Runbook

This is the self-contained procedure for running a runtime trace hunt. It is written for a fresh agent with no chat history.

Use [RUNTIME_TRACE_HUNT_GUIDE.md](./RUNTIME_TRACE_HUNT_GUIDE.md) as the data source for DSL details, current coverage, sparse cells, and historical sweep notes. Use [RUNTIME_TRACE_BUGS.md](./RUNTIME_TRACE_BUGS.md) only after a corpus run, for dedupe and evidence.

## Goal

Find new runtime/model reconciliation bugs by adding or mutating explicit domain traces. A hunt is not a seed sweep and not repeated replay of the same corpus. The runner executes selected traces and records failures; the adversarial work is the agent's active trace design loop around the runner.

## Files

- [RUNTIME_TRACE_HUNT_RUNBOOK.md](./RUNTIME_TRACE_HUNT_RUNBOOK.md): procedure, stop rule, commands, and responsibilities.
- [RUNTIME_TRACE_HUNT_GUIDE.md](./RUNTIME_TRACE_HUNT_GUIDE.md): DSL summary, threat model, coverage matrix, sparse targets, and historical sweep data.
- [src/background/controller.test.ts](./src/background/controller.test.ts): typed trace DSL and trace definitions. Discovery traces live in `RUNTIME_DOMAIN_DISCOVERY_TRACES`.
- [scripts/hunt-runtime-traces.mjs](./scripts/hunt-runtime-traces.mjs): corpus runner, profile selection, batching, finding recording, and dedupe signature extraction.
- [RUNTIME_TRACE_BUGS.md](./RUNTIME_TRACE_BUGS.md): evidence log. Do not use it as the mutation prompt.
- [ARCHITECTURE.md](./ARCHITECTURE.md): current runtime reconciliation architecture: ledger, scope index, shape facts, lifecycle journal, history replay, and projection boundaries.

## Non-Negotiable Rules

- Do not read fixed repro histories in `RUNTIME_TRACE_BUGS.md` before proposing mutations.
- Do not mutate regression traces during discovery.
- Add or clone neutral `discovery` traces; do not edit a trace after it produces a new distinct failure.
- If a corpus run reveals multiple distinct signatures, record all of them before changing the corpus.
- If a trace fails because of a harness/precondition issue, fix the trace or harness before counting it as a runtime finding.
- If a trace fails by runtime invariant, freeze it and let the runner record the finding.
- Do not fix bugs during a hunt. Fixes happen in a later principled fix pass.
- Perf guard is not part of discovery. It is mandatory for the later fix/promote pass.

## Runner Semantics

`pnpm trace-hunt:runtime` runs the selected explicit domain corpus once.

Default behavior:

- profile: `discovery`
- bug log: `RUNTIME_TRACE_BUGS.md`
- batch size: `RUNTIME_TRACE_HUNT_BATCH_SIZE` or `20`
- stop rule printed by the runner: informational only; the runner does not perform adversarial mutation
- failures: green batches run together; failing batches split into single-trace replays and record precise findings

Useful commands:

```sh
pnpm trace-hunt:runtime
RUNTIME_TRACE_HUNT_PROFILE=regression RUNTIME_TRACE_HUNT_BATCH_SIZE=50 pnpm trace-hunt:runtime
RUNTIME_TRACE_HUNT_PROFILE=all pnpm trace-hunt:runtime
RUNTIME_TRACE_HUNT_TRACE_IDS=<trace-id-a>,<trace-id-b> pnpm trace-hunt:runtime
RUNTIME_TRACE_HUNT_SHOW_TRACE_IDS=1 pnpm trace-hunt:runtime
RUNTIME_TRACE_BUGS_FILE=/private/tmp/runtime-smoke.md RUNTIME_TRACE_HUNT_PROFILE=discovery RUNTIME_TRACE_HUNT_STOP_AFTER_CLEAN=1 pnpm trace-hunt:runtime
```

If the runner does not complete the selected corpus, the run is not clean. Increase `RUNTIME_TRACE_HUNT_CORPUS_RUN_MS`, reduce explicit trace selection, or fix the runner/harness issue before counting the block.

## Five-Minute Active Mutation Block

A block is a timed period of active adversarial mutation effort. It is not an add/replay/corpus-review cycle.

One block usually contains multiple cycles like:

1. inspect a sparse cell or code path;
2. add or clone one or more discovery traces;
3. replay the new trace ids;
4. run the discovery corpus;
5. review/dedupe results;
6. choose the next mutation while the same timer is still running.

A clean block means the whole timed block found no new distinct signature. Do not count each cycle as a separate clean block.

Start a timer for active work. Active work includes:

- reading the runbook, guide, current discovery traces, and relevant runtime code;
- selecting sparse coverage cells;
- designing traces or asking proposal scouts for ideas;
- editing or adding discovery traces;
- explicit replay of new trace IDs;
- deduping post-run failures.

Active work excludes:

- waiting for `pnpm trace-hunt:runtime`;
- waiting for `pnpm test`, `pnpm build`, or regression replay;
- idle time.

The active timer should be roughly five minutes of thinking/editing/reviewing time. Pause the timer while commands run. Resume the same block after the command finishes.

If a run is clean quickly, that is only one clean cycle inside the current block. Keep mutating within the same block until about five minutes of active work have elapsed. If a run is slow, finish the corpus run so findings are complete, pause the active timer while it runs, then resume mutation effort afterward.

Examples:

- Wrong: add one trace, replay it, run the corpus, see no failure, call that "clean block 1."
- Right: add one trace, replay it, run the corpus, see no failure, continue using the same active timer to inspect a different sparse cell and add another trace.
- Wrong: wait eight minutes for the corpus runner and count that as more than one block.
- Right: wait eight minutes for the corpus runner, count zero mutation minutes during the wait, then resume the same block.

Stop only after three full five-minute active mutation blocks find no new distinct signature.

## Coverage Accounting

A clean hunt result is not the same thing as complete coverage. Bug yield and coverage are separate facts.

When a sparse target finds nothing, update its coverage status based on the traces that were actually added and run, not on the absence of findings.

Use these labels when updating the coverage matrix or hunt notes:

- `unsampled`: no meaningful trace exercises the cell yet.
- `sampled-clean`: one or a few traces exercised the cell and found no new signature, but important axes remain untested.
- `moderate`: several qualitatively different traces exercise independent axes inside the cell, such as provenance, event order, snapshot confidence, restart boundary, history replay, rejection, stale echo, or strict shape assertion.
- `covered/regression-backed`: the cell has broad discovery coverage and known historical failures are promoted to regression, or focused regression tests lock the important behavior.

Do not automatically promote a sparse cell to `moderate` or `covered` because a corpus run was green. A cell can remain sparse after a clean hunt if the new traces were shallow, narrow, mostly one-basin variants, or did not cross the important lifecycle/freshness/history boundaries.

After each clean block, write down both:

- **bug yield:** new signatures, duplicate signatures, or none;
- **coverage movement:** what qualitative axes were newly sampled and whether the cell remains sparse.

## Mutation Temperature Ladder

Use the ladder to avoid staying in one local basin.

- **Rung 0:** start each block with sparse cells from the current hunt target.
- **Rung 1 after one clean active block:** change one major axis: provenance, event source, event order, snapshot confidence, restart boundary, or assertion type.
- **Rung 2 after two clean active blocks:** combine two or three semantic axes that have not recently been combined, such as browser-created plus history replay plus partial query, or restored plus fullscreen plus native move.
- **Temporal heat check before stopping:** at Rung 2, include at least one trace where different clocks disagree across a command or reconciliation boundary. Prefer pre-command runtime evidence, command-owned echo/rejection, then session/query/refresh evidence.
- **Rung 3 after three clean active blocks:** stop the hunt. Do not keep replaying or lightly varying the same basin.

## Subagent Scouts

Use subagent scouts when the environment supports them to improve mutation diversity. They are not required for the hunt to be valid, because a single main agent can perform the same scout roles inline. Whether scouts are separate agents or simulated by the main agent, their responsibility is proposal-only.

The main thread always owns file edits, explicit replay, corpus runs, dedupe, bug-log updates, and the stop condition.

Scout inputs:

- Read this runbook, [RUNTIME_TRACE_HUNT_GUIDE.md](./RUNTIME_TRACE_HUNT_GUIDE.md), current discovery traces, and relevant controller/reconciler/ledger/scope/shape code for the assigned axis.
- Do not read fixed repro histories in [RUNTIME_TRACE_BUGS.md](./RUNTIME_TRACE_BUGS.md) before proposing mutations.
- Do not edit files, run the corpus, promote traces, or record findings.

Scout roles:

- Browser/runtime scout: native open/move/close, tab order, focus/session/fullscreen/window-state, browser event ordering, and partial query evidence.
- Model/history scout: undo/redo, restore/delete/close, lifecycle journal boundaries, abrupt restart, command rejection, and stale durable state.
- Sparse/user-behavior scout: restored-window browser actions, external links, opener chains, multi-window skew, sidebar reopen/startup-adjacent runtime drift, and actions users are likely to perform quickly.

Scout output contract:

```text
- id: <neutral-prefix-candidate>
- target axes: <3-6 tags>
- pseudo actions: <DSL-ish ordered list>
- oracle: <invariant/assertion the trace should stress>
- novelty: <why this is not just a fixed-basin clone>
- risk: <possible harness/precondition concern, if any>
```

## Main Thread Procedure

1. Preflight when starting a new hunt:
   ```sh
   pnpm test
   pnpm build
   node --check scripts/hunt-runtime-traces.mjs
   RUNTIME_TRACE_HUNT_PROFILE=regression RUNTIME_TRACE_HUNT_BATCH_SIZE=50 pnpm trace-hunt:runtime
   ```
2. Read this runbook, then read [RUNTIME_TRACE_HUNT_GUIDE.md](./RUNTIME_TRACE_HUNT_GUIDE.md) for the current matrix and sparse cells.
3. Read current discovery traces in [src/background/controller.test.ts](./src/background/controller.test.ts). Do not read fixed repro details in [RUNTIME_TRACE_BUGS.md](./RUNTIME_TRACE_BUGS.md) yet.
4. Pick one or two sparse cells and the current temperature rung.
5. Add or clone neutral `discovery` traces with threat-model notes and tags.
6. Replay new traces explicitly:
   ```sh
   RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=<new-trace-ids> pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime domain traces" --reporter=dot
   ```
7. Run the discovery profile once:
   ```sh
   pnpm trace-hunt:runtime
   ```
8. If failures occur, inspect the runner output and [RUNTIME_TRACE_BUGS.md](./RUNTIME_TRACE_BUGS.md) for dedupe/evidence only after the run. Freeze failing traces.
9. Record a mutation block note, including both bug yield and coverage movement.
10. If any new distinct signature appears, reset the clean-block count to zero and start a new active block.
11. If no new distinct signature appears, continue active mutation work until the block has consumed about five minutes, then increment the clean-block count and raise temperature for the next block. Do not mark the target covered unless the traces added real qualitative coverage.
12. Stop only after three complete clean active blocks.
13. Final safety:
    ```sh
    RUNTIME_TRACE_HUNT_PROFILE=regression RUNTIME_TRACE_HUNT_BATCH_SIZE=50 pnpm trace-hunt:runtime
    RUNTIME_TRACE_BUGS_FILE=/private/tmp/runtime-discovery-smoke.md RUNTIME_TRACE_HUNT_PROFILE=discovery RUNTIME_TRACE_HUNT_STOP_AFTER_CLEAN=1 pnpm trace-hunt:runtime
    ```

## Mutation Block Note Template

```md
- Block:
- Active effort:
- Rung:
- Axes changed:
- Temporal boundaries crossed:
- New/changed trace ids:
- Explicit replay result:
- Discovery runner result:
- New signatures:
- Coverage movement:
- Dedupe/result:
```

## Fix Pass Boundary

After a hunt finds bugs, stop discovery and propose principled fixes. A finding is not fixed until:

- failing traces are promoted to regression or otherwise covered by focused regression tests;
- correctness checks pass;
- selected perf guard passes for the changed blast radius;
- `RUNTIME_TRACE_BUGS.md` records the fix analysis and perf result.

Common fix-pass commands:

```sh
pnpm test
pnpm build
node --check scripts/hunt-runtime-traces.mjs
RUNTIME_TRACE_HUNT_PROFILE=regression RUNTIME_TRACE_HUNT_BATCH_SIZE=50 pnpm trace-hunt:runtime
pnpm perf:runtime-guard
```
