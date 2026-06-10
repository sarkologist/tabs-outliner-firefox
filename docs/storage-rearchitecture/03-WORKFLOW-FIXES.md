# Workflow Fixes: Ending the Correctness/Performance Pendulum

The repo's documented workflow (AGENTS.md, the hunt guides/runbooks,
autoresearch/CORRECTNESS_GUARDS.md) is unusually strong, but it has structural
asymmetries that produced the current situation: a correctness branch sitting at HEAD
with the project's own perf gate red and no PERFORMANCE_NOTES entry, weeks after the
perf side was meticulously gated. These are the process changes. Each is small; do
them as documentation edits plus, where noted, a script.

## W-1 Make the gates symmetric (the core fix)

**Today**: perf experiments must pass correctness lanes before `keep`
(CORRECTNESS_GUARDS.md:17), and the *runtime* hunt has a fix-pass perf gate
(RUNTIME_TRACE_HUNT_GUIDE.md "Fix-Pass Performance Gate": do not promote while the
guard is red). But: the projection hunt's fix gate has no perf step
(SIDEBAR_PROJECTION_HUNT_GUIDE.md "Fix Gate"), nothing frames ordinary bug-fix
commits (outside a formal hunt) as perf-gated at all, and the rule is evidently
skippable under pressure — `72bc680`/`369c317` shipped with the guard red.

**Changes**:

1. AGENTS.md — replace the perf bullet's scope with an explicit definition:
   *"Any change that touches save/load/compaction, broadcast, reconciliation,
   projection, or patch paths is performance-relevant **regardless of why it was
   made**. Before committing such a change, run `pnpm perf:runtime-guard` (plus
   `pnpm perf:sidebar-projection-guard` for sidebar paths) and record the result in
   PERFORMANCE_NOTES.md or in the commit message. A red guard blocks the commit —
   fix the cost or explicitly change the budget (W-2); never ship red."*
2. SIDEBAR_PROJECTION_HUNT_GUIDE.md — add the same "Fix-Pass Performance Gate"
   section the runtime guide already has, naming
   `pnpm perf:sidebar-projection-guard`.
3. Enforcement beats discipline: add a CI job (`.github/workflows`) that runs
   `pnpm perf:runtime-guard` on every PR. Synthetic Node profiles are
   machine-variance-sensitive; have CI enforce only the **hard counters**
   (`saves`, `journalWrites`, `storageSetCalls`, broadcast counts, query counts) and
   report-but-not-fail timing budgets; timing stays a local pre-commit gate. (The
   guard script already separates "hard-max" counters from "timing" — see the FAIL
   output format — so this is a flag, not a rewrite.)

## W-2 Budget changes are reviewed contract changes

Budgets in `scripts/runtime-perf-budgets.json` have never been loosened (good). Write
that down so it survives pressure: a budget may be changed only in a commit whose
message starts `budget:` and that contains a PERFORMANCE_NOTES.md entry stating the
scenario, the old/new value, the measured cause, and why the cost is fundamental
rather than incidental. "Fix now, re-green later" is explicitly disallowed — that is
exactly how the June-7 regression shipped. Tightening budgets after wins (Phase 4.7
of the plan) follows the same procedure.

## W-3 One invariant registry instead of scattered intent

The audit found invariants spread across ARCHITECTURE.md ("Important Invariants"),
AGENTS.md ("state the intended invariant first"), hunt-guide prose, trace comments,
and oracle laws — with no IDs, so hunts, guards, and fixes can't reference them and
nobody notices when two mechanisms enforce (or contradict) the same one.

Create `INVARIANTS.md` at the repo root: numbered entries (`I-1`, `I-2`, …), each with
a one-line statement, owner mechanism (model / reconciler / storage / workflow), and
the tests/guards that enforce it. Seed it with §9 of
[01-TARGET-ARCHITECTURE.md](./01-TARGET-ARCHITECTURE.md) plus the existing
ARCHITECTURE.md list. Then:

- new trace classes in the hunt guides must cite an invariant ID (the runbook's
  "state the intended invariant first" becomes "add or cite an `I-n`");
- guard/assert code that exists to defend an invariant says so
  (`// I-2: no silent stale fallback`) so future cleanup (like Phase 4 deletions)
  knows what may be removed when the invariant is enforced elsewhere;
- RUNTIME_TRACE_BUGS.md fix-analysis entries tag the invariant they restored.

## W-4 Storage fault lane (close the epistemic gap)

The trace-hunt corpus (1,100+ traces) replays model/controller logic over a faithful
storage mock — so it can prove the *model* never drops a closed subtree, but says
nothing about torn writes, failed sets, or kill-mid-flush, which is where the
remaining loss vectors live (diagnosis §4). That is why "is it fixed?" was
undecidable.

Changes:

1. The fault-injection helper from Phase 1 of the plan
   (`src/test/faulty-storage.test-support.ts`) becomes a first-class lane:
   add `storage-faults` to `autoresearch/CORRECTNESS_GUARDS.md` lanes and to
   `scripts/autoresearch-accept.mjs` `LANE_COMMANDS`
   (command: `pnpm exec vitest run src/background/storage-v4.test.ts
   src/background/outline-journal.test.ts -t "fault|torn|crash|restart"`).
2. Extend the soak (`scripts/run-generated-soak.mjs`) with a storage-fault mode:
   every N generated operations, randomly inject one of {failed set, torn set,
   simulated restart}, then assert I-1/I-2 (acked mutations survive; loader never
   silently time-travels). Run it in the same cadence as `pnpm test:soak`.
3. Hunt coverage matrix (RUNTIME_TRACE_HUNT_GUIDE.md): add a "process death /
   storage fault" axis to the temperature ladder so future hunts mutate along it.

## W-5 Incident log policy: a signal, not a diary

The log was added writing an entry per save flush — noise that costs a write per
flush and guarantees the 100-entry ring holds nothing but routine saves by the time
an anomaly occurs. After P0.1 (anomalies only), add the triage loop that makes it
useful:

- Options page already displays the log (`369c317`); document in the runbooks:
  any `closedSubtreeGuardRestore`, `storageLoadStructureRepair`, `saveFlushAnomaly`,
  `stateSaveFailed`, `v3LoadSalvaged`/`v4Recovery*`, or `staleV2FallbackUsed`
  incident observed during dogfooding is treated like a failing hunt trace: freeze
  the evidence (export the log + profile), reduce to a deterministic trace, file in
  RUNTIME_TRACE_BUGS.md.

## W-6 A decidable "definition of fixed" for the data-loss bug

Declare the storage bug fixed when **all** of:

1. Phase 0 + Phases 1–3 landed; `pnpm perf:runtime-guard` green at the merge commit.
2. The storage-fault soak (W-4.2) passes 3 consecutive runs with ≥10k operations.
3. The I-1 restart tests and torn-write tests of Phases 2–3 are in the regression set.
4. 14 days of dogfooding with zero non-routine incidents (W-5 list), with the
   incident log checked weekly (calendar it).
5. The closed-subtree guard (kept as detector, Phase 4.3) has fired zero times in
   those 14 days.

Until then the honest status is "open, mitigated". After it, the guard demotion and
scaffolding deletion (Phase 4) are justified — that is what converts defense-in-depth
debt back into a simple system.

## W-7 Evidence-log hygiene

RUNTIME_TRACE_BUGS.md is 905 KB / ~7.3 k lines and the hunt guide already warns not
to read it during discovery; PERFORMANCE_NOTES.md is 150 KB. Both are append-only
working memory that has outgrown its container. Mechanical fix, no information loss:

- Move entries for findings fixed before the previous month into
  `archive/RUNTIME_TRACE_BUGS-<yyyy-mm>.md` (same for performance notes), keeping in
  the live file: the finding index, open/uncertain items, the current coverage
  matrix, and the last 30 days. Add one line to each live file stating the archive
  location. Keep the "Current Asymptotics Audit" table in the live
  PERFORMANCE_NOTES.md permanently.

## W-8 Keep the autoresearch stop-rules; add one cross-check

The perf autoresearch loop (≥10%/50 ms improvement, 3-discard stop) and the hunt stop
rule (3 clean blocks) are sound. One addition: an autoresearch `keep` that changes
**save timing or save shape** (the acceptance TSV already records the experiment
description) must also run the storage-fault soak (W-4.2) before final acceptance —
this is the exact class of change (`5798b61` defer structural saves,
`bbf39e4` carry live placement) that historically traded the loss window for latency
without a gate noticing.
