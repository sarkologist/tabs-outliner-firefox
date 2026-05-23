# Runtime Trace Bug Hunt

This file records distinct bugs found by deterministic adversarial runtime concurrency traces.
The hunt intentionally documents findings without fixing them.

Run the hunt with:

```sh
pnpm trace-hunt:runtime
```

Default hunt bounds:

- Iteration limit: 5 minutes
- Stop condition: 3 consecutive iterations with no new distinct findings
- Test target: `src/background/controller.test.ts`
- Test name: `adversarial runtime concurrency traces`

## Last Run

- Completed: 2026-05-23T09:39:12.505Z
- Seed range scanned: 10000 through 11496
- Distinct findings recorded: 6
- Stop condition reached: iterations 8, 9, and 10 found no new distinct signatures
- Duplicate failures during final clean streak: 133

## Findings

### RT-001 tab 1 active flag diverged
<!-- signature: tab <id> active flag diverged
step: concurrent-activated-tab-then-group
dispatch tab <id> activated, then group tab <id> -->

- First seen: 2026-05-23T09:13:27.016Z
- Repro: `env GENERATED_TRACE_BASE_SEED=10001 GENERATED_TRACE_SEED_COUNT=1 GENERATED_TRACE_STEPS=120 pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime concurrency traces" --reporter=dot`
- Status: documented, not fixed.

```text
seed 10001
step 1: concurrent-activated-tab-then-group
dispatch tab 2 activated, then group tab 1
```

<!-- hunt-iteration: {"at":"2026-05-23T09:13:27.017Z","iteration":1,"firstSeed":10000,"lastSeed":10001,"runs":2,"failures":1,"duplicateFailures":0,"newFindings":1} -->

### RT-002 tab 101 active flag diverged
<!-- signature: tab <id> active flag diverged
step: concurrent-created-tab-then-group
dispatch tab <id> created, then group tab <id> -->

- First seen: 2026-05-23T09:13:45.142Z
- Repro: `env GENERATED_TRACE_BASE_SEED=10020 GENERATED_TRACE_SEED_COUNT=1 GENERATED_TRACE_STEPS=120 pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime concurrency traces" --reporter=dot`
- Status: documented, not fixed.

```text
seed 10020
step 1: outliner-close-window
outliner close window 10 with 2 tabs
step 2: open-tab
open tab 100 in window 20 with stale query
step 3: concurrent-focused-window-then-group
dispatch window 20 focused, then group tab 100
step 4: outliner-delete-window-rejecting-close
outliner delete window 21 with rejecting close
step 5: open-tab
open tab 101 in window 20
step 6: concurrent-created-tab-then-group
dispatch tab 102 created, then group tab 101
```

<!-- hunt-iteration: {"at":"2026-05-23T09:13:45.143Z","iteration":2,"firstSeed":10002,"lastSeed":10020,"runs":19,"failures":3,"duplicateFailures":2,"newFindings":1} -->

### RT-003 live window IDs match runtime windows
<!-- signature: live window IDs match runtime windows
step: stale-live-tab-created-event-stale-query
dispatch stale live created event for moved tab <id> with stale query window <id> -->

- First seen: 2026-05-23T09:16:13.394Z
- Repro: `env GENERATED_TRACE_BASE_SEED=10175 GENERATED_TRACE_SEED_COUNT=1 GENERATED_TRACE_STEPS=120 pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime concurrency traces" --reporter=dot`
- Status: documented, not fixed.

```text
seed 10175
step 1: concurrent-created-tab-then-group
dispatch tab 100 created, then group tab 1
step 2: stale-live-tab-created-event-stale-query
dispatch stale live created event for moved tab 1 with stale query window 10
step 3: activate-tab
activate tab 3
step 4: concurrent-updated-tab-then-group
dispatch tab 1 updated, then group tab 3
step 5: concurrent-activated-tab-then-group
step 6: stale-live-tab-created-event-stale-query
dispatch stale live created event for moved tab 1 with stale query window 10
```

<!-- hunt-iteration: {"at":"2026-05-23T09:16:13.395Z","iteration":3,"firstSeed":10021,"lastSeed":10175,"runs":155,"failures":21,"duplicateFailures":20,"newFindings":1} -->

### RT-004 live window IDs match runtime windows
<!-- signature: live window IDs match runtime windows
step: activate-tab-with-stale-query
 -->

- First seen: 2026-05-23T09:17:15.938Z
- Repro: `env GENERATED_TRACE_BASE_SEED=10240 GENERATED_TRACE_SEED_COUNT=1 GENERATED_TRACE_STEPS=120 pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime concurrency traces" --reporter=dot`
- Status: documented, not fixed.

```text
seed 10240
step 1: concurrent-updated-tab-then-group
dispatch tab 2 updated, then group tab 1
step 2: activate-tab
activate tab 2
step 3: native-close-tab
native close last tab 1 in window 21
step 4: open-tab
open tab 100 in window 10 with stale query
step 5: open-tab
open tab 101 in window 10
step 6: concurrent-activated-tab-then-group
dispatch tab 3 activated, then group tab 100
step 7: concurrent-updated-tab-then-group
dispatch tab 100 updated, then group tab 101
step 8: activate-tab
activate tab 100
step 9: activate-tab-with-stale-query
activate tab 100 with stale query for moved tab 100
```

<!-- hunt-iteration: {"at":"2026-05-23T09:17:15.939Z","iteration":4,"firstSeed":10176,"lastSeed":10240,"runs":65,"failures":15,"duplicateFailures":14,"newFindings":1} -->

### RT-005 tab 101 has wrong live window
<!-- signature: tab <id> has wrong live window
step: stale-live-tab-updated-event-stale-query
dispatch stale live updated event for tab <id> with stale query window <id> -->

- First seen: 2026-05-23T09:17:47.746Z
- Repro: `env GENERATED_TRACE_BASE_SEED=10267 GENERATED_TRACE_SEED_COUNT=1 GENERATED_TRACE_STEPS=120 pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime concurrency traces" --reporter=dot`
- Status: documented, not fixed.

```text
seed 10267
step 1: open-tab
open tab 100 in window 20
step 2: outliner-close-window
outliner close window 20 with 2 tabs
step 3: open-tab
open tab 101 in window 10
step 4: outliner-group-tab
outliner group tab 101
step 5: open-tab
open tab 102 in window 10
step 6: stale-live-tab-updated-event-stale-query
dispatch stale live updated event for tab 101 with stale query window 10
step 7: concurrent-updated-tab-then-group
dispatch tab 102 updated, then group tab 102
step 8: concurrent-updated-tab-then-group
dispatch tab 101 updated, then group tab 1
step 9: concurrent-focused-window-then-group
step 10: open-tab
open tab 103 in window 21
step 11: outliner-close-window
outliner close window 23 with 1 tabs
step 12: open-tab
open tab 104 in window 10
step 13: concurrent-focused-window-then-group
dispatch window 10 focused, then group tab 104
step 14: stale-live-tab-updated-event
dispatch stale live updated event for tab 101 in old window 10
step 15: stale-live-tab-updated-event-stale-query
dispatch stale live updated event for tab 101 with stale query window 10
```

<!-- hunt-iteration: {"at":"2026-05-23T09:17:47.746Z","iteration":5,"firstSeed":10241,"lastSeed":10267,"runs":27,"failures":3,"duplicateFailures":2,"newFindings":1} -->

<!-- hunt-iteration: {"at":"2026-05-23T09:22:46.211Z","iteration":6,"firstSeed":10268,"lastSeed":10549,"runs":282,"failures":56,"duplicateFailures":56,"newFindings":0} -->

### RT-006 live window IDs match runtime windows
<!-- signature: live window IDs match runtime windows
step: stale-live-tab-updated-event-stale-query
dispatch stale live updated event for tab <id> with stale query window <id> -->

- First seen: 2026-05-23T09:24:16.720Z
- Repro: `env GENERATED_TRACE_BASE_SEED=10636 GENERATED_TRACE_SEED_COUNT=1 GENERATED_TRACE_STEPS=120 pnpm exec vitest run src/background/controller.test.ts --testNamePattern "adversarial runtime concurrency traces" --reporter=dot`
- Status: documented, not fixed.

```text
seed 10636
step 1: outliner-group-tab
outliner group tab 1
step 2: open-tab
open tab 100 in window 20 with stale query
step 3: concurrent-activated-tab-then-group
dispatch tab 100 activated, then group tab 100
step 4: outliner-close-window
outliner close window 21 with 1 tabs
step 5: open-tab
open tab 101 in window 20
step 6: activate-tab-with-stale-query
activate tab 100 with stale query for moved tab 100
step 7: concurrent-updated-tab-then-group
dispatch tab 100 updated, then group tab 101
step 8: activate-tab
activate tab 3
step 9: concurrent-focused-window-then-group
step 10: stale-live-tab-updated-event-stale-query
dispatch stale live updated event for tab 100 with stale query window 20
```

<!-- hunt-iteration: {"at":"2026-05-23T09:24:16.721Z","iteration":7,"firstSeed":10550,"lastSeed":10636,"runs":87,"failures":15,"duplicateFailures":14,"newFindings":1} -->

<!-- hunt-iteration: {"at":"2026-05-23T09:29:15.582Z","iteration":8,"firstSeed":10637,"lastSeed":10936,"runs":300,"failures":35,"duplicateFailures":35,"newFindings":0} -->

<!-- hunt-iteration: {"at":"2026-05-23T09:34:14.141Z","iteration":9,"firstSeed":10937,"lastSeed":11213,"runs":277,"failures":49,"duplicateFailures":49,"newFindings":0} -->

<!-- hunt-iteration: {"at":"2026-05-23T09:39:12.505Z","iteration":10,"firstSeed":11214,"lastSeed":11496,"runs":283,"failures":49,"duplicateFailures":49,"newFindings":0} -->
