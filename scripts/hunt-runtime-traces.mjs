#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const TEST_FILE = "src/background/controller.test.ts";
const TEST_NAME = "adversarial runtime domain traces";
const BUG_FILE = process.env.RUNTIME_TRACE_BUGS_FILE ?? "RUNTIME_TRACE_BUGS.md";
const CORPUS_RUN_CAP_MS =
  positiveIntegerEnv("RUNTIME_TRACE_HUNT_CORPUS_RUN_MS") ??
  positiveIntegerEnv("RUNTIME_TRACE_HUNT_ITERATION_MS") ??
  5 * 60 * 1000;
const STOP_AFTER_CLEAN = positiveIntegerEnv("RUNTIME_TRACE_HUNT_STOP_AFTER_CLEAN") ?? 3;
const MIN_RUN_BUDGET_MS = 2_000;
const TRACE_HUNT_PROFILE = traceHuntProfile();
const REGRESSION_TRACE_IDS = [
  "rt-active-race",
  "rt-created-race-after-window-close",
  "rt-stale-created-after-move",
  "rt-stale-created-after-fresh-relocation-event",
  "rt-stale-updated-after-move",
  "rt-stale-updated-after-fresh-relocation-event",
  "rt-stale-activation-after-fresh-relocation-event",
  "rt-native-close-after-relocation",
  "rt-restore-delete-delayed-stale-event",
  "rt-direct-new-window-stale-created-after-fresh-event",
  "rt-top-level-stale-updated-after-fresh-event",
  "rt-repeated-direct-relocation-stale-events",
  "rt-repeated-direct-relocation-with-filler-stale-events",
  "rt-repeated-direct-relocation-native-close-stale-event",
  "rt-repeated-top-level-relocation-with-filler-stale-events",
  "rt-direct-new-window-native-close-old-window-stale-created",
  "rt-direct-new-window-outliner-close-old-window-stale-updated",
  "rt-top-level-native-close-old-window-stale-created",
  "rt-group-native-close-old-window-stale-updated",
  "rt-direct-new-window-delete-old-window-rejecting-close-stale-created",
  "rt-top-level-delete-old-window-rejecting-close-stale-updated",
  "rt-group-delete-old-window-rejecting-close-stale-created",
  "rt-top-level-outliner-close-old-window-stale-created",
  "rt-group-outliner-close-old-window-stale-updated",
  "rt-direct-new-window-native-close-destination-stale-updated",
  "rt-direct-new-window-outliner-close-destination-stale-created",
  "rt-top-level-native-close-destination-stale-updated",
  "rt-group-outliner-close-destination-stale-created",
  "rt-direct-new-window-native-close-tab-removed-only-stale-created",
  "rt-direct-new-window-native-close-session-only-stale-updated",
  "rt-top-level-native-close-tab-removed-only-stale-created",
  "rt-group-native-close-session-only-stale-updated",
  "rt-top-level-native-close-session-only-stale-updated",
  "rt-group-native-close-tab-removed-only-stale-created",
  "rt-direct-new-window-native-close-default-order-stale-created",
  "rt-direct-new-window-stale-activation-after-focus",
  "rt-top-level-stale-activation-after-focus",
  "rt-group-stale-activation-after-focus",
  "rt-direct-new-window-old-window-activation-with-stale-relocated-tab",
  "rt-top-level-old-window-activation-with-stale-relocated-tab",
  "rt-group-old-window-activation-with-stale-relocated-tab",
  "rt-direct-new-window-command-focus-stale-updated",
  "rt-top-level-command-focus-stale-created",
  "rt-group-command-focus-stale-updated",
  "rt-direct-new-window-delete-tab-rejecting-close-stale-created",
  "rt-top-level-delete-tab-rejecting-close-stale-updated",
  "rt-group-delete-tab-rejecting-close-stale-created",
  "rt-direct-new-window-outliner-close-tab-stale-updated",
  "rt-top-level-outliner-close-tab-stale-created",
  "rt-group-outliner-close-tab-stale-updated",
  "rt-direct-new-window-close-source-tab-stale-created",
  "rt-top-level-close-source-tab-stale-updated",
  "rt-group-close-source-tab-stale-created",
  "rt-direct-new-window-stale-updated-fast-path-after-fresh-event",
  "rt-top-level-stale-created-fast-path-after-fresh-event",
  "rt-group-stale-updated-fast-path-after-fresh-event",
  "rt-direct-new-window-paired-stale-events-after-fresh-event",
  "rt-top-level-paired-stale-events-after-fresh-event",
  "rt-group-paired-stale-events-after-fresh-event",
  "rt-direct-new-window-open-active-source-tab-stale-updated",
  "rt-top-level-open-active-source-tab-stale-created",
  "rt-group-open-active-source-tab-stale-updated",
  "rt-direct-new-window-open-active-destination-tab-stale-created",
  "rt-top-level-open-active-destination-tab-stale-updated",
  "rt-group-open-active-destination-tab-stale-created",
  "dh-undo-redo-stale-refresh",
  "dh-history-redo-stale-created",
  "dh-history-redo-session-refresh",
  "dh-restore-history-redo-delayed-echo",
  "dh-manual-stale-query-after-source-close",
  "dh-history-manual-stale-query",
  "dh-repeated-relocation-manual-stale-query",
  "dh-opener-source-close-manual-stale-query",
  "dh-group-source-close-manual-stale-query",
  "dh-top-level-source-close-manual-stale-query",
  "dh-created-race-source-close-manual-stale-query",
  "dh-activation-race-source-close-manual-stale-query",
  "dh-outliner-source-close-manual-stale-query",
  "dh-delete-reject-source-window-manual-stale-query",
  "dh-outliner-source-tab-close-manual-stale-query",
  "dh-relocated-tab-missing-manual-query",
  "dh-fresh-relocated-tab-missing-manual-query",
  "dh-opener-child-missing-manual-query",
  "dh-opener-history-missing-source-query",
  "dh-restore-history-missing-window-query",
  "dh-restore-history-reordered-query",
  "dh-restore-history-redo-partial-query",
  "dh-window-close-destination-tabs-only",
  "dh-window-close-nested-window-only",
  "dh-window-close-source-tabs-only",
  "dh-query-missing-source-window-after-relocation",
  "dh-relocation-create-reject-direct",
  "dh-relocation-create-reject-opener",
  "dh-focus-session-missing-window-query",
  "dh-focus-session-missing-background-window",
  "dh-opener-focus-session-missing-window",
  "dh-window-close-opener-tabs-only",
  "dh-window-close-destination-window-only",
  "dh-nested-tabs-only-session-refresh",
  "dh-restore-history-source-reordered-session",
  "dh-relocation-reject-after-reordered-query",
  "dh-focus-relocation-missing-background-query",
  "dh-relocation-reject-after-focus-session",
  "dh-restore-history-missing-source-session",
  "dh-destination-default-close-missing-source-query",
  "dh-restore-redo-missing-source-session",
  "dh-restart-destination-close-stale-old",
  "dh-restore-native-close-after-restart",
  "dh-restart-destination-tabs-only-stale-created",
  "dh-restart-destination-window-first-paired-old",
  "dh-restart-relocated-tab-session-only-stale",
  "dh-restart-relocated-tab-removed-only-stale",
  "dh-restart-restore-native-tabs-only-stale",
  "dh-restart-restore-native-window-first-stale",
  "dh-restart-reject-destination-close-stale-old",
  "dh-restart-group-destination-close-stale-old",
  "dh-restart-top-level-destination-close-stale-old",
  "dh-restart-outliner-close-destination-stale-old",
  "dh-restart-outliner-close-tab-stale-old",
  "dh-restart-destination-window-only-manual-stale",
  "dh-restart-destination-tabs-only-manual-stale",
  "dh-restart-restore-native-default-stale",
  "dh-restart-restore-native-tab-close-stale",
  "dh-restart-restore-outliner-close-window-stale",
  "dh-restart-delete-reject-destination-close-created",
  "dh-opener-chain-restart-destination-close",
  "dh-restart-focus-command-no-relocation",
  "dh-restart-focus-command-complete-refresh",
  "dh-restart-focus-command-session-activation",
  "dh-restart-focus-command-missing-focused-tab",
  "dh-restart-missing-opened-tab-query",
  "dh-restart-missing-background-opened-tab-query",
  "dh-restart-missing-active-opened-tab-query",
  "dh-restart-missing-opener-child-query",
  "bh-restore-create-reject-tab",
  "bh-restore-create-reject-window",
  "bh-restart-restore-create-reject-tab",
  "bh-restore-create-reject-tab-after-redo",
  "bh-restart-restore-create-reject-window"
];
const DISCOVERY_TRACE_IDS = [
  "dh-restore-delayed-focus-refresh",
  "dh-opener-reparent-refresh",
  "dh-nested-parent-native-close",
  "dh-partial-subtree-delete-reject",
  "dh-focus-session-activation-refresh",
  "dh-opener-source-close-stale-child",
  "dh-opener-session-only-close",
  "dh-refresh-delete-reject-relocated-tab",
  "dh-repeated-relocation-refresh-stale-pair",
  "dh-fresh-event-source-close-stale-echo",
  "dh-focus-churn-refresh-stale-echo",
  "dh-refresh-delete-reject-window-after-relocation",
  "dh-created-race-refresh-delete-reject",
  "dh-activation-race-source-close-refresh",
  "dh-update-race-focus-session-refresh",
  "dh-restore-delete-stale-created-refresh",
  "dh-restore-delete-stale-updated-session",
  "dh-nested-opener-delete-reject",
  "dh-nested-opener-native-close-refresh",
  "dh-command-focus-relocated-refresh-stale",
  "dh-outliner-close-destination-refresh-stale",
  "dh-outliner-close-tab-refresh-stale",
  "dh-source-sibling-close-refresh-stale",
  "dh-manual-stale-query-after-relocation",
  "dh-delete-reject-manual-stale-query",
  "dh-outliner-close-manual-stale-query",
  "dh-restore-delete-manual-stale-query",
  "dh-session-only-close-manual-stale-query",
  "dh-destination-close-manual-stale-query",
  "dh-focus-override-manual-stale-query",
  "dh-current-session-refresh-after-relocation",
  "dh-opener-current-refresh-after-relocation",
  "dh-focus-current-refresh-after-relocation",
  "dh-race-current-refresh-after-relocation",
  "dh-repeated-current-refresh-after-relocation",
  "dh-restore-current-refresh-after-delete",
  "dh-delete-reject-current-refresh",
  "dh-outliner-close-current-refresh",
  "dh-native-close-current-refresh",
  "dh-destination-window-current-refresh",
  "dh-source-sibling-current-refresh",
  "dh-active-destination-current-refresh",
  "dh-active-source-current-refresh",
  "dh-opener-active-current-refresh",
  "dh-race-active-current-refresh",
  "dh-repeated-active-current-refresh",
  "dh-opener-history-reordered-source-query",
  "dh-opener-history-missing-moved-tab-query",
  "dh-window-close-source-window-first",
  "dh-query-reordered-destination-after-relocation",
  "dh-query-reordered-focus-session",
  "dh-opener-history-reordered-focused-query",
  "dh-window-close-source-window-only",
  "dh-window-close-destination-window-first",
  "dh-query-missing-destination-window-after-relocation",
  "dh-query-reordered-source-after-relocation",
  "dh-nested-focus-session-missing-destination",
  "dh-nested-query-reordered-destination",
  "dh-opener-history-reordered-background-query",
  "dh-session-reordered-both-windows",
  "dh-nested-source-reordered-focus-session",
  "dh-source-window-only-session-refresh",
  "dh-destination-window-first-session-refresh",
  "dh-focus-session-destination-reordered",
  "dh-opener-history-window-only-source-close",
  "dh-restore-redo-source-reordered-session",
  "dh-opener-source-default-close-session",
  "dh-destination-default-close-session-refresh",
  "dh-focus-session-reordered-background-query",
  "dh-opener-history-source-default-close-session",
  "dh-destination-default-close-reordered-source-query",
  "dh-direct-move-source-reordered-session",
  "dh-top-level-move-background-reordered-focus",
  "dh-opener-tab-close-reordered-session",
  "dh-stale-created-destination-reordered-session",
  "dh-session-only-tab-close-reordered-source",
  "dh-opener-history-reordered-session",
  "dh-flush-stale-created-destination-reordered",
  "dh-restart-relocation-old-updated",
  "dh-restart-relocation-current-then-old-created",
  "dh-restart-source-close-missing-destination",
  "dh-restart-restore-redo-delayed-echo",
  "dh-restart-delete-reject-relocation",
  "dh-restart-focus-command-activation",
  "dh-opener-chain-restart-source-close",
  "dh-session-only-tab-close-after-restart-query",
  "dh-restart-paired-old-events-after-current-refresh",
  "dh-nested-restart-missing-background",
  "dh-restart-reject-destination-missing-query",
  "dh-restart-source-window-only-stale-updated",
  "dh-restart-source-tabs-only-stale-created",
  "dh-restart-source-default-missing-destination",
  "dh-restart-focus-session-source-window-only-old",
  "dh-restart-baseline-reordered-focus-session",
  "dh-restart-opener-chain-reordered-query",
  "dh-restart-missing-background-no-command",
  "dh-restart-session-refresh-after-open",
  "dh-restart-native-tab-close-current-refresh",
  "dh-restart-focus-current-window-reordered",
  "dh-restart-close-undo-refresh",
  "dh-restart-native-background-window-close",
  "dh-restart-delete-reject-background-window-refresh",
  "dh-restart-opener-native-child-close-refresh",
  "dh-restart-session-only-background-tab-query",
  "dh-restart-focus-command-background-activation",
  "dh-restart-noop-complete-refresh",
  "dh-restart-opened-tabs-reordered-both",
  "dh-restart-opener-chain-current-refresh",
  "dh-restart-nonlast-tab-removed-only-refresh",
  "dh-restart-session-only-opened-tab-refresh",
  "dh-restart-window-focus-churn-refresh",
  "dh-restart-open-active-background-refresh",
  "dh-restart-session-reordered-both-current",
  "dh-restart-multiple-opens-complete-refresh",
  "dh-restart-updated-tabs-complete-refresh",
  "dh-restart-window-focus-reordered-current",
  "dh-restart-updated-reordered-both",
  "dh-restart-opener-focus-current-refresh",
  "dh-restart-native-nonlast-session-refresh",
  "dh-restart-created-updated-session-refresh",
  "dh-restart-opener-updated-reordered",
  "bh-deep-nested-double-group-source-window-only",
  "bh-deep-nested-destination-multitab-close",
  "bh-deep-nested-focus-session-churn",
  "bh-deep-nested-source-tabs-only-after-second-group",
  "bh-opener-grandchild-relocation-refresh",
  "bh-opener-chain-undo-redo-source-close",
  "bh-opener-child-native-close-missing-query",
  "bh-opener-focus-reordered-cross-window",
  "bh-restore-window-native-window-only",
  "bh-restore-redo-reordered-query",
  "bh-restore-delete-reject-after-undo",
  "bh-restore-delayed-event-after-focus",
  "bh-focus-reject-same-window-session",
  "bh-focus-reject-cross-window-reordered",
  "bh-relocation-reject-after-second-relocation",
  "bh-query-missing-source-reorder-destination",
  "bh-query-empty-focused-background-active",
  "bh-query-reordered-source-destination-pair",
  "bh-query-stale-event-partial-two-windows",
  "bh-restart-opener-restore-mix",
  "bh-restart-focus-reject",
  "bh-restart-multiple-open-session-churn",
  "bh-restart-runtime-id-gap",
  "bh-focus-reject-after-relocation-restart",
  "bh-focus-reject-opener-chain-query",
  "bh-query-missing-two-windows-reordered-focus",
  "bh-restart-query-skew-id-gap-focus",
  "bh-nested-destination-window-only-stale-pair",
  "bh-nested-destination-tabs-only-reordered-source",
  "bh-opener-grandchild-source-window-only-after-focus",
  "bh-opener-destination-tabs-only-extra-tab",
  "bh-query-missing-both-windows-sequential",
  "bh-restart-opener-native-gap-reordered",
  "bh-relocation-reject-then-focus-reject",
  "bh-history-opener-grandchild-missing-window",
  "bh-history-nested-source-tabs-only-focus",
  "bh-native-source-tabs-then-window-after-focus",
  "bh-native-destination-window-only-after-reorder",
  "bh-query-no-command-missing-reordered-pair",
  "bh-restart-after-partial-query-no-command",
  "bh-session-focus-nested-multitab-restart",
  "bh-opener-history-source-tabs-only-restart",
  "bh-query-two-command-windows-reordered",
  "bh-native-background-window-only-no-command-restart",
  "bh-focus-after-session-only-close-missing-source",
  "bh-relocation-reject-source-window-only-restart"
];
const ALL_TRACE_IDS = [...REGRESSION_TRACE_IDS, ...DISCOVERY_TRACE_IDS];
const TRACE_TAGS = new Map([
  ...REGRESSION_TRACE_IDS.map((traceId) => [traceId, ["known-finding"]]),
  ["dh-restore-delayed-focus-refresh", ["restore", "delayed-event", "focus", "manual-refresh"]],
  ["dh-opener-reparent-refresh", ["opener", "reparenting", "relocation", "manual-refresh"]],
  ["dh-nested-parent-native-close", ["nested-window", "native-close", "relocation", "stale-event"]],
  ["dh-partial-subtree-delete-reject", ["delete-rejection", "partial-close", "stale-event", "tombstone"]],
  ["dh-focus-session-activation-refresh", ["focus", "activation", "session", "manual-refresh"]],
  ["dh-undo-redo-stale-refresh", ["undo-redo", "stale-event", "relocation", "manual-refresh"]],
  ["dh-opener-source-close-stale-child", ["opener", "reparenting", "relocation", "native-close", "stale-event"]],
  ["dh-opener-session-only-close", ["opener", "relocation", "session", "stale-event", "tombstone"]],
  ["dh-refresh-delete-reject-relocated-tab", ["manual-refresh", "delete-rejection", "relocation", "tombstone", "stale-event"]],
  ["dh-history-redo-stale-created", ["undo-redo", "stale-event", "relocation", "manual-refresh"]],
  ["dh-history-redo-session-refresh", ["undo-redo", "session", "relocation", "stale-event", "manual-refresh"]],
  ["dh-restore-history-redo-delayed-echo", ["restore", "undo-redo", "delayed-event", "stale-event", "manual-refresh"]],
  ["dh-repeated-relocation-refresh-stale-pair", ["relocation", "manual-refresh", "stale-event", "paired-echo"]],
  ["dh-fresh-event-source-close-stale-echo", ["relocation", "native-close", "fresh-event", "stale-event", "manual-refresh"]],
  ["dh-focus-churn-refresh-stale-echo", ["focus", "activation", "relocation", "manual-refresh", "stale-event"]],
  ["dh-refresh-delete-reject-window-after-relocation", ["delete-rejection", "relocation", "manual-refresh", "tombstone", "stale-event"]],
  ["dh-created-race-refresh-delete-reject", ["created-event", "race", "relocation", "manual-refresh", "delete-rejection"]],
  ["dh-activation-race-source-close-refresh", ["activation", "race", "relocation", "native-close", "manual-refresh"]],
  ["dh-update-race-focus-session-refresh", ["updated-event", "race", "relocation", "focus", "session", "manual-refresh"]],
  ["dh-restore-delete-stale-created-refresh", ["restore", "delayed-event", "stale-event", "manual-refresh", "tombstone"]],
  ["dh-restore-delete-stale-updated-session", ["restore", "delayed-event", "session", "stale-event", "tombstone"]],
  ["dh-nested-opener-delete-reject", ["opener", "nested-window", "delete-rejection", "stale-event", "tombstone"]],
  ["dh-nested-opener-native-close-refresh", ["opener", "nested-window", "native-close", "manual-refresh", "stale-event"]],
  ["dh-command-focus-relocated-refresh-stale", ["focus", "relocation", "manual-refresh", "stale-event"]],
  ["dh-outliner-close-destination-refresh-stale", ["outliner-close", "relocation", "manual-refresh", "stale-event", "tombstone"]],
  ["dh-outliner-close-tab-refresh-stale", ["outliner-close", "relocation", "manual-refresh", "stale-event", "tombstone"]],
  ["dh-source-sibling-close-refresh-stale", ["outliner-close", "relocation", "manual-refresh", "stale-event"]],
  ["dh-manual-stale-query-after-relocation", ["manual-refresh", "stale-query", "relocation", "stale-event"]],
  ["dh-manual-stale-query-after-source-close", ["manual-refresh", "stale-query", "native-close", "relocation", "tombstone"]],
  ["dh-history-manual-stale-query", ["undo-redo", "manual-refresh", "stale-query", "relocation"]],
  ["dh-delete-reject-manual-stale-query", ["delete-rejection", "manual-refresh", "stale-query", "relocation", "tombstone"]],
  ["dh-outliner-close-manual-stale-query", ["outliner-close", "manual-refresh", "stale-query", "relocation", "tombstone"]],
  ["dh-repeated-relocation-manual-stale-query", ["manual-refresh", "stale-query", "relocation", "paired-echo"]],
  ["dh-restore-delete-manual-stale-query", ["restore", "delayed-event", "manual-refresh", "stale-query", "tombstone"]],
  ["dh-session-only-close-manual-stale-query", ["session", "manual-refresh", "stale-query", "relocation", "tombstone"]],
  ["dh-destination-close-manual-stale-query", ["native-close", "manual-refresh", "stale-query", "relocation", "tombstone"]],
  ["dh-focus-override-manual-stale-query", ["focus", "activation", "manual-refresh", "stale-query", "relocation"]],
  ["dh-opener-source-close-manual-stale-query", ["opener", "native-close", "manual-refresh", "stale-query", "relocation"]],
  ["dh-group-source-close-manual-stale-query", ["nested-window", "native-close", "manual-refresh", "stale-query", "relocation"]],
  ["dh-top-level-source-close-manual-stale-query", ["native-close", "manual-refresh", "stale-query", "relocation"]],
  ["dh-created-race-source-close-manual-stale-query", ["created-event", "race", "native-close", "manual-refresh", "stale-query", "relocation"]],
  ["dh-activation-race-source-close-manual-stale-query", ["activation", "race", "native-close", "manual-refresh", "stale-query", "relocation"]],
  ["dh-outliner-source-close-manual-stale-query", ["outliner-close", "manual-refresh", "stale-query", "relocation", "tombstone"]],
  ["dh-delete-reject-source-window-manual-stale-query", ["delete-rejection", "manual-refresh", "stale-query", "relocation", "tombstone"]],
  ["dh-outliner-source-tab-close-manual-stale-query", ["outliner-close", "manual-refresh", "stale-query", "relocation"]],
  ["dh-relocated-tab-missing-manual-query", ["manual-refresh", "partial-snapshot", "relocation"]],
  ["dh-fresh-relocated-tab-missing-manual-query", ["manual-refresh", "partial-snapshot", "relocation", "fresh-event"]],
  ["dh-opener-child-missing-manual-query", ["manual-refresh", "partial-snapshot", "opener", "relocation"]],
  ["dh-current-session-refresh-after-relocation", ["session", "manual-refresh", "relocation", "fresh-event"]],
  ["dh-opener-current-refresh-after-relocation", ["opener", "manual-refresh", "relocation", "fresh-event"]],
  ["dh-focus-current-refresh-after-relocation", ["focus", "activation", "manual-refresh", "relocation", "fresh-event"]],
  ["dh-race-current-refresh-after-relocation", ["created-event", "race", "manual-refresh", "relocation", "fresh-event"]],
  ["dh-repeated-current-refresh-after-relocation", ["paired-echo", "manual-refresh", "relocation", "fresh-event"]],
  ["dh-restore-current-refresh-after-delete", ["restore", "delayed-event", "session", "manual-refresh"]],
  ["dh-delete-reject-current-refresh", ["delete-rejection", "session", "manual-refresh", "tombstone"]],
  ["dh-outliner-close-current-refresh", ["outliner-close", "session", "manual-refresh", "tombstone"]],
  ["dh-native-close-current-refresh", ["native-close", "session", "manual-refresh", "tombstone"]],
  ["dh-destination-window-current-refresh", ["native-close", "session", "manual-refresh", "relocation", "tombstone"]],
  ["dh-source-sibling-current-refresh", ["outliner-close", "session", "manual-refresh", "relocation"]],
  ["dh-active-destination-current-refresh", ["activation", "manual-refresh", "relocation", "fresh-event"]],
  ["dh-active-source-current-refresh", ["activation", "manual-refresh", "relocation", "fresh-event"]],
  ["dh-opener-active-current-refresh", ["opener", "activation", "manual-refresh", "relocation", "fresh-event"]],
  ["dh-race-active-current-refresh", ["activation", "race", "manual-refresh", "relocation", "fresh-event"]],
  ["dh-repeated-active-current-refresh", ["activation", "paired-echo", "manual-refresh", "relocation", "fresh-event"]],
  ["dh-opener-history-missing-source-query", ["opener", "undo-redo", "partial-snapshot", "manual-refresh", "relocation"]],
  ["dh-opener-history-reordered-source-query", ["opener", "undo-redo", "stale-query", "manual-refresh", "relocation"]],
  ["dh-opener-history-missing-moved-tab-query", ["opener", "undo-redo", "partial-snapshot", "manual-refresh", "relocation"]],
  ["dh-restore-history-missing-window-query", ["restore", "undo-redo", "partial-snapshot", "manual-refresh", "delayed-event"]],
  ["dh-restore-history-reordered-query", ["restore", "undo-redo", "stale-query", "manual-refresh", "delayed-event"]],
  ["dh-restore-history-redo-partial-query", ["restore", "undo-redo", "partial-snapshot", "session", "manual-refresh"]],
  ["dh-window-close-source-window-first", ["native-close", "relocation", "event-order", "stale-event"]],
  ["dh-window-close-destination-tabs-only", ["native-close", "relocation", "event-order", "tombstone"]],
  ["dh-window-close-nested-window-only", ["native-close", "nested-window", "event-order", "manual-refresh"]],
  ["dh-window-close-source-tabs-only", ["native-close", "relocation", "event-order", "manual-refresh"]],
  ["dh-query-missing-source-window-after-relocation", ["partial-snapshot", "manual-refresh", "relocation", "stale-query"]],
  ["dh-query-reordered-destination-after-relocation", ["stale-query", "manual-refresh", "relocation", "fresh-event"]],
  ["dh-query-reordered-focus-session", ["stale-query", "focus", "activation", "session", "manual-refresh"]],
  ["dh-relocation-create-reject-direct", ["relocation", "command-rejection", "partial-close", "manual-refresh"]],
  ["dh-relocation-create-reject-opener", ["opener", "relocation", "command-rejection", "partial-close"]],
  ["dh-opener-history-reordered-focused-query", ["opener", "undo-redo", "stale-query", "manual-refresh", "relocation"]],
  ["dh-window-close-source-window-only", ["native-close", "relocation", "event-order", "manual-refresh"]],
  ["dh-window-close-destination-window-first", ["native-close", "relocation", "event-order", "tombstone"]],
  ["dh-query-missing-destination-window-after-relocation", ["partial-snapshot", "manual-refresh", "relocation", "stale-query"]],
  ["dh-query-reordered-source-after-relocation", ["stale-query", "manual-refresh", "relocation", "fresh-event"]],
  ["dh-focus-session-missing-window-query", ["focus", "activation", "session", "partial-snapshot", "manual-refresh"]],
  ["dh-focus-session-missing-background-window", ["focus", "activation", "session", "partial-snapshot", "manual-refresh"]],
  ["dh-nested-focus-session-missing-destination", ["nested-window", "focus", "session", "partial-snapshot", "relocation"]],
  ["dh-opener-focus-session-missing-window", ["opener", "focus", "session", "partial-snapshot", "manual-refresh"]],
  ["dh-window-close-opener-tabs-only", ["opener", "native-close", "event-order", "partial-snapshot"]],
  ["dh-window-close-destination-window-only", ["native-close", "relocation", "event-order", "manual-refresh"]],
  ["dh-nested-query-reordered-destination", ["nested-window", "stale-query", "manual-refresh", "relocation"]],
  ["dh-opener-history-reordered-background-query", ["opener", "undo-redo", "stale-query", "manual-refresh", "relocation"]],
  ["dh-session-reordered-both-windows", ["session", "stale-query", "manual-refresh", "focus", "activation"]],
  ["dh-nested-source-reordered-focus-session", ["nested-window", "focus", "session", "stale-query", "manual-refresh"]],
  ["dh-source-window-only-session-refresh", ["native-close", "event-order", "session", "relocation", "manual-refresh"]],
  ["dh-destination-window-first-session-refresh", ["native-close", "event-order", "session", "relocation", "manual-refresh"]],
  ["dh-nested-tabs-only-session-refresh", ["nested-window", "native-close", "event-order", "session", "manual-refresh"]],
  ["dh-restore-history-source-reordered-session", ["restore", "undo-redo", "session", "stale-query", "manual-refresh"]],
  ["dh-relocation-reject-after-reordered-query", ["relocation", "command-rejection", "stale-query", "manual-refresh"]],
  ["dh-focus-session-destination-reordered", ["focus", "session", "stale-query", "relocation", "manual-refresh"]],
  ["dh-opener-history-window-only-source-close", ["opener", "undo-redo", "native-close", "event-order", "manual-refresh"]],
  ["dh-restore-redo-source-reordered-session", ["restore", "undo-redo", "session", "stale-query", "manual-refresh"]],
  ["dh-focus-relocation-missing-background-query", ["focus", "activation", "relocation", "partial-snapshot", "manual-refresh"]],
  ["dh-opener-source-default-close-session", ["opener", "native-close", "event-order", "session", "manual-refresh"]],
  ["dh-relocation-reject-after-focus-session", ["relocation", "command-rejection", "focus", "session", "manual-refresh"]],
  ["dh-destination-default-close-session-refresh", ["native-close", "event-order", "session", "relocation", "manual-refresh"]],
  ["dh-restore-history-missing-source-session", ["restore", "undo-redo", "session", "partial-snapshot", "manual-refresh"]],
  ["dh-focus-session-reordered-background-query", ["focus", "activation", "session", "stale-query", "manual-refresh"]],
  ["dh-opener-history-source-default-close-session", ["opener", "undo-redo", "native-close", "event-order", "session"]],
  ["dh-destination-default-close-missing-source-query", ["native-close", "event-order", "partial-snapshot", "relocation", "manual-refresh"]],
  ["dh-restore-redo-missing-source-session", ["restore", "undo-redo", "session", "partial-snapshot", "manual-refresh"]],
  ["dh-destination-default-close-reordered-source-query", ["native-close", "event-order", "stale-query", "relocation", "manual-refresh"]],
  ["dh-direct-move-source-reordered-session", ["relocation", "session", "stale-query", "manual-refresh"]],
  ["dh-top-level-move-background-reordered-focus", ["relocation", "focus", "stale-query", "manual-refresh"]],
  ["dh-opener-tab-close-reordered-session", ["opener", "native-close", "session", "stale-query", "manual-refresh"]],
  ["dh-stale-created-destination-reordered-session", ["relocation", "session", "stale-event", "stale-query", "manual-refresh"]],
  ["dh-session-only-tab-close-reordered-source", ["native-close", "session", "stale-query", "manual-refresh"]],
  ["dh-opener-history-reordered-session", ["opener", "undo-redo", "session", "stale-query", "manual-refresh"]],
  ["dh-flush-stale-created-destination-reordered", ["relocation", "stale-event", "stale-query", "manual-refresh"]],
  ["dh-restart-relocation-old-updated", ["restart", "reconciliation", "relocation", "tombstone", "stale-event", "partial-snapshot"]],
  ["dh-restart-relocation-current-then-old-created", ["restart", "reconciliation", "relocation", "stale-event", "metadata"]],
  ["dh-restart-destination-close-stale-old", ["restart", "reconciliation", "relocation", "native-close", "tombstone", "stale-event", "session"]],
  ["dh-restart-source-close-missing-destination", ["restart", "reconciliation", "relocation", "native-close", "partial-snapshot", "stale-event"]],
  ["dh-restart-restore-redo-delayed-echo", ["restart", "reconciliation", "restore", "undo-redo", "tombstone", "stale-event", "partial-snapshot", "session"]],
  ["dh-restart-delete-reject-relocation", ["restart", "reconciliation", "command-rejection", "relocation", "partial-snapshot", "stale-event"]],
  ["dh-restart-focus-command-activation", ["restart", "reconciliation", "relocation", "focus", "activation", "partial-snapshot"]],
  ["dh-opener-chain-restart-source-close", ["restart", "reconciliation", "opener", "relocation", "native-close", "stale-event"]],
  ["dh-restore-native-close-after-restart", ["restart", "reconciliation", "restore", "native-close", "tombstone", "stale-event"]],
  ["dh-session-only-tab-close-after-restart-query", ["restart", "reconciliation", "native-close", "session", "partial-snapshot", "activation"]],
  ["dh-restart-paired-old-events-after-current-refresh", ["restart", "reconciliation", "relocation", "stale-event", "manual-refresh"]],
  ["dh-nested-restart-missing-background", ["restart", "reconciliation", "nested", "relocation", "focus", "session", "partial-snapshot", "stale-event"]],
  ["dh-restart-destination-tabs-only-stale-created", ["restart", "reconciliation", "relocation", "native-close", "event-order", "stale-event", "tombstone"]],
  ["dh-restart-destination-window-first-paired-old", ["restart", "reconciliation", "relocation", "native-close", "event-order", "stale-event", "paired-echo"]],
  ["dh-restart-relocated-tab-session-only-stale", ["restart", "reconciliation", "relocation", "native-close", "session", "stale-event", "tombstone"]],
  ["dh-restart-relocated-tab-removed-only-stale", ["restart", "reconciliation", "relocation", "native-close", "event-order", "stale-event", "tombstone"]],
  ["dh-restart-restore-native-tabs-only-stale", ["restart", "reconciliation", "restore", "native-close", "event-order", "stale-event", "tombstone"]],
  ["dh-restart-restore-native-window-first-stale", ["restart", "reconciliation", "restore", "native-close", "event-order", "stale-event", "tombstone"]],
  ["dh-restart-reject-destination-close-stale-old", ["restart", "reconciliation", "command-rejection", "relocation", "native-close", "stale-event", "tombstone"]],
  ["dh-restart-reject-destination-missing-query", ["restart", "reconciliation", "command-rejection", "relocation", "partial-snapshot", "stale-event"]],
  ["dh-restart-source-window-only-stale-updated", ["restart", "reconciliation", "relocation", "native-close", "event-order", "stale-event", "stale-query"]],
  ["dh-restart-source-tabs-only-stale-created", ["restart", "reconciliation", "relocation", "native-close", "event-order", "stale-event", "stale-query"]],
  ["dh-restart-source-default-missing-destination", ["restart", "reconciliation", "relocation", "native-close", "partial-snapshot", "stale-event"]],
  ["dh-restart-group-destination-close-stale-old", ["restart", "reconciliation", "nested", "relocation", "native-close", "stale-event", "stale-query"]],
  ["dh-restart-top-level-destination-close-stale-old", ["restart", "reconciliation", "relocation", "native-close", "stale-event", "stale-query"]],
  ["dh-restart-outliner-close-destination-stale-old", ["restart", "reconciliation", "relocation", "outliner-close", "stale-event", "stale-query", "tombstone"]],
  ["dh-restart-outliner-close-tab-stale-old", ["restart", "reconciliation", "relocation", "outliner-close", "stale-event", "stale-query", "tombstone"]],
  ["dh-restart-focus-session-source-window-only-old", ["restart", "reconciliation", "relocation", "focus", "session", "native-close", "event-order", "stale-event"]],
  ["dh-restart-destination-window-only-manual-stale", ["restart", "reconciliation", "relocation", "native-close", "event-order", "stale-query", "manual-refresh"]],
  ["dh-restart-destination-tabs-only-manual-stale", ["restart", "reconciliation", "relocation", "native-close", "event-order", "stale-query", "manual-refresh"]],
  ["dh-restart-restore-native-default-stale", ["restart", "reconciliation", "restore", "native-close", "event-order", "stale-event", "tombstone"]],
  ["dh-restart-restore-native-tab-close-stale", ["restart", "reconciliation", "restore", "native-close", "session", "stale-event", "tombstone"]],
  ["dh-restart-restore-outliner-close-window-stale", ["restart", "reconciliation", "restore", "outliner-close", "stale-event", "tombstone"]],
  ["dh-restart-delete-reject-destination-close-created", ["restart", "reconciliation", "command-rejection", "relocation", "native-close", "stale-event", "tombstone"]],
  ["dh-opener-chain-restart-destination-close", ["restart", "reconciliation", "opener", "relocation", "native-close", "stale-event", "stale-query"]],
  ["dh-restart-baseline-reordered-focus-session", ["restart", "reconciliation", "focus", "session", "stale-query", "manual-refresh"]],
  ["dh-restart-opener-chain-reordered-query", ["restart", "reconciliation", "opener", "stale-query", "manual-refresh"]],
  ["dh-restart-missing-background-no-command", ["restart", "reconciliation", "partial-snapshot", "manual-refresh"]],
  ["dh-restart-session-refresh-after-open", ["restart", "reconciliation", "created-event", "session", "manual-refresh"]],
  ["dh-restart-native-tab-close-current-refresh", ["restart", "reconciliation", "native-close", "session", "manual-refresh"]],
  ["dh-restart-focus-current-window-reordered", ["restart", "reconciliation", "focus", "activation", "stale-query", "manual-refresh"]],
  ["dh-restart-close-undo-refresh", ["restart", "reconciliation", "outliner-close", "undo-redo", "manual-refresh"]],
  ["dh-restart-native-background-window-close", ["restart", "reconciliation", "native-close", "event-order", "manual-refresh"]],
  ["dh-restart-delete-reject-background-window-refresh", ["restart", "reconciliation", "delete-rejection", "tombstone", "manual-refresh"]],
  ["dh-restart-opener-native-child-close-refresh", ["restart", "reconciliation", "opener", "native-close", "manual-refresh"]],
  ["dh-restart-session-only-background-tab-query", ["restart", "reconciliation", "session", "native-close", "stale-query", "manual-refresh"]],
  ["dh-restart-focus-command-no-relocation", ["restart", "reconciliation", "focus", "activation", "stale-query", "manual-refresh"]],
  ["dh-restart-focus-command-complete-refresh", ["restart", "reconciliation", "focus", "activation", "manual-refresh"]],
  ["dh-restart-focus-command-session-activation", ["restart", "reconciliation", "focus", "activation", "session", "manual-refresh"]],
  ["dh-restart-focus-command-background-activation", ["restart", "reconciliation", "focus", "activation", "stale-query", "manual-refresh"]],
  ["dh-restart-focus-command-missing-focused-tab", ["restart", "reconciliation", "focus", "activation", "partial-snapshot", "manual-refresh"]],
  ["dh-restart-noop-complete-refresh", ["restart", "reconciliation", "manual-refresh"]],
  ["dh-restart-opened-tabs-reordered-both", ["restart", "reconciliation", "created-event", "stale-query", "manual-refresh"]],
  ["dh-restart-opener-chain-current-refresh", ["restart", "reconciliation", "opener", "manual-refresh"]],
  ["dh-restart-nonlast-tab-removed-only-refresh", ["restart", "reconciliation", "native-close", "event-order", "manual-refresh"]],
  ["dh-restart-session-only-opened-tab-refresh", ["restart", "reconciliation", "session", "native-close", "manual-refresh"]],
  ["dh-restart-window-focus-churn-refresh", ["restart", "reconciliation", "focus", "manual-refresh"]],
  ["dh-restart-open-active-background-refresh", ["restart", "reconciliation", "created-event", "activation", "manual-refresh"]],
  ["dh-restart-missing-opened-tab-query", ["restart", "reconciliation", "created-event", "partial-snapshot", "manual-refresh"]],
  ["dh-restart-session-reordered-both-current", ["restart", "reconciliation", "session", "stale-query", "manual-refresh"]],
  ["dh-restart-missing-background-opened-tab-query", ["restart", "reconciliation", "created-event", "partial-snapshot", "manual-refresh"]],
  ["dh-restart-missing-active-opened-tab-query", ["restart", "reconciliation", "created-event", "activation", "partial-snapshot", "manual-refresh"]],
  ["dh-restart-missing-opener-child-query", ["restart", "reconciliation", "opener", "created-event", "partial-snapshot", "manual-refresh"]],
  ["dh-restart-multiple-opens-complete-refresh", ["restart", "reconciliation", "created-event", "manual-refresh"]],
  ["dh-restart-updated-tabs-complete-refresh", ["restart", "reconciliation", "updated-event", "manual-refresh"]],
  ["dh-restart-window-focus-reordered-current", ["restart", "reconciliation", "focus", "stale-query", "manual-refresh"]],
  ["dh-restart-updated-reordered-both", ["restart", "reconciliation", "updated-event", "stale-query", "manual-refresh"]],
  ["dh-restart-opener-focus-current-refresh", ["restart", "reconciliation", "opener", "focus", "manual-refresh"]],
  ["dh-restart-native-nonlast-session-refresh", ["restart", "reconciliation", "native-close", "session", "manual-refresh"]],
  ["dh-restart-created-updated-session-refresh", ["restart", "reconciliation", "created-event", "updated-event", "session", "manual-refresh"]],
  ["dh-restart-opener-updated-reordered", ["restart", "reconciliation", "opener", "updated-event", "stale-query", "manual-refresh"]],
  ["bh-deep-nested-double-group-source-window-only", ["breadth", "nested", "nested-window", "native-close", "event-order", "stale-event"]],
  ["bh-deep-nested-destination-multitab-close", ["breadth", "nested", "nested-window", "native-close", "manual-refresh"]],
  ["bh-deep-nested-focus-session-churn", ["breadth", "nested", "focus", "session", "stale-query", "manual-refresh"]],
  ["bh-deep-nested-source-tabs-only-after-second-group", ["breadth", "nested", "native-close", "event-order", "stale-event"]],
  ["bh-opener-grandchild-relocation-refresh", ["breadth", "opener", "reparenting", "relocation", "partial-snapshot", "stale-event"]],
  ["bh-opener-chain-undo-redo-source-close", ["breadth", "opener", "undo-redo", "native-close", "event-order", "stale-query"]],
  ["bh-opener-child-native-close-missing-query", ["breadth", "opener", "native-close", "partial-snapshot", "session"]],
  ["bh-opener-focus-reordered-cross-window", ["breadth", "opener", "focus", "activation", "relocation", "stale-query"]],
  ["bh-restore-window-native-window-only", ["breadth", "restore", "undo-redo", "native-close", "event-order"]],
  ["bh-restore-redo-reordered-query", ["breadth", "restore", "undo-redo", "stale-query", "manual-refresh"]],
  ["bh-restore-delete-reject-after-undo", ["breadth", "restore", "undo-redo", "delete-rejection", "tombstone"]],
  ["bh-restore-delayed-event-after-focus", ["breadth", "restore", "focus", "delayed-event", "stale-event"]],
  ["bh-focus-reject-same-window-session", ["breadth", "focus", "activation", "command-rejection", "session"]],
  ["bh-focus-reject-cross-window-reordered", ["breadth", "focus", "activation", "command-rejection", "stale-query"]],
  ["bh-restore-create-reject-tab", ["breadth", "restore", "command-rejection", "created-event", "session"]],
  ["bh-relocation-reject-after-second-relocation", ["breadth", "relocation", "command-rejection", "partial-snapshot", "stale-event"]],
  ["bh-query-missing-source-reorder-destination", ["breadth", "partial-snapshot", "stale-query", "relocation", "manual-refresh"]],
  ["bh-query-empty-focused-background-active", ["breadth", "partial-snapshot", "focus", "activation", "manual-refresh"]],
  ["bh-query-reordered-source-destination-pair", ["breadth", "stale-query", "relocation", "manual-refresh"]],
  ["bh-query-stale-event-partial-two-windows", ["breadth", "stale-event", "partial-snapshot", "relocation", "manual-refresh"]],
  ["bh-restart-opener-restore-mix", ["breadth", "restart", "opener", "restore", "undo-redo", "manual-refresh"]],
  ["bh-restart-focus-reject", ["breadth", "restart", "focus", "activation", "command-rejection", "stale-query"]],
  ["bh-restart-multiple-open-session-churn", ["breadth", "restart", "created-event", "session", "stale-query", "manual-refresh"]],
  ["bh-restart-runtime-id-gap", ["breadth", "restart", "created-event", "native-close", "session", "manual-refresh"]],
  ["bh-restore-create-reject-window", ["breadth", "restore", "command-rejection", "created-event", "session"]],
  ["bh-restart-restore-create-reject-tab", ["breadth", "restart", "restore", "command-rejection", "created-event", "manual-refresh"]],
  ["bh-restore-create-reject-tab-after-redo", ["breadth", "restore", "undo-redo", "command-rejection", "created-event"]],
  ["bh-restart-restore-create-reject-window", ["breadth", "restart", "restore", "command-rejection", "created-event", "manual-refresh"]],
  ["bh-focus-reject-after-relocation-restart", ["breadth", "restart", "focus", "activation", "command-rejection", "relocation", "stale-query"]],
  ["bh-focus-reject-opener-chain-query", ["breadth", "opener", "focus", "activation", "command-rejection", "relocation", "stale-query"]],
  ["bh-query-missing-two-windows-reordered-focus", ["breadth", "partial-snapshot", "stale-query", "focus", "activation", "manual-refresh"]],
  ["bh-restart-query-skew-id-gap-focus", ["breadth", "restart", "native-close", "focus", "activation", "command-rejection", "stale-query"]],
  ["bh-nested-destination-window-only-stale-pair", ["breadth", "nested", "nested-window", "native-close", "event-order", "stale-event"]],
  ["bh-nested-destination-tabs-only-reordered-source", ["breadth", "nested", "nested-window", "native-close", "event-order", "stale-query"]],
  ["bh-opener-grandchild-source-window-only-after-focus", ["breadth", "opener", "focus", "activation", "native-close", "event-order", "stale-event"]],
  ["bh-opener-destination-tabs-only-extra-tab", ["breadth", "opener", "native-close", "event-order", "partial-snapshot", "relocation"]],
  ["bh-query-missing-both-windows-sequential", ["breadth", "partial-snapshot", "manual-refresh", "focus", "activation"]],
  ["bh-restart-opener-native-gap-reordered", ["breadth", "restart", "opener", "native-close", "session", "stale-query"]],
  ["bh-relocation-reject-then-focus-reject", ["breadth", "relocation", "focus", "activation", "command-rejection", "stale-query"]],
  ["bh-history-opener-grandchild-missing-window", ["breadth", "opener", "undo-redo", "relocation", "partial-snapshot", "stale-query"]],
  ["bh-history-nested-source-tabs-only-focus", ["breadth", "nested", "undo-redo", "native-close", "focus", "event-order"]],
  ["bh-native-source-tabs-then-window-after-focus", ["breadth", "native-close", "event-order", "focus", "relocation", "manual-refresh"]],
  ["bh-native-destination-window-only-after-reorder", ["breadth", "native-close", "event-order", "stale-query", "relocation", "manual-refresh"]],
  ["bh-query-no-command-missing-reordered-pair", ["breadth", "partial-snapshot", "stale-query", "manual-refresh", "focus"]],
  ["bh-restart-after-partial-query-no-command", ["breadth", "restart", "partial-snapshot", "created-event", "session", "manual-refresh"]],
  ["bh-session-focus-nested-multitab-restart", ["breadth", "nested", "restart", "focus", "session", "stale-query"]],
  ["bh-opener-history-source-tabs-only-restart", ["breadth", "opener", "undo-redo", "restart", "native-close", "event-order"]],
  ["bh-query-two-command-windows-reordered", ["breadth", "relocation", "stale-query", "manual-refresh", "focus"]],
  ["bh-native-background-window-only-no-command-restart", ["breadth", "native-close", "event-order", "restart", "created-event", "manual-refresh"]],
  ["bh-focus-after-session-only-close-missing-source", ["breadth", "focus", "activation", "native-close", "session", "partial-snapshot", "command-rejection"]],
  ["bh-relocation-reject-source-window-only-restart", ["breadth", "relocation", "command-rejection", "restart", "native-close", "stale-event"]]
]);
const hasExplicitTraceIds = typeof process.env.RUNTIME_TRACE_HUNT_TRACE_IDS === "string" &&
  process.env.RUNTIME_TRACE_HUNT_TRACE_IDS.trim() !== "";

const traceIds = selectedTraceIds();
if (traceIds.length === 0) {
  throw new Error("RUNTIME_TRACE_HUNT_TRACE_IDS selected no traces");
}
const bugLog = loadBugLog(BUG_FILE);

ensureBugLogFile(BUG_FILE);

console.log(`Runtime trace hunt writing findings to ${BUG_FILE}`);
console.log(`This corpus run is capped at ${CORPUS_RUN_CAP_MS}ms.`);
console.log(`Agent stop rule: stop after ${STOP_AFTER_CLEAN} full 5-minute discovery mutation block(s) with no new distinct findings.`);
console.log(`Trace strategy: run the selected domain corpus once, recording every distinct failure; Codex/humans mutate discovery trace actions between runs.`);
console.log(`Trace profile: ${TRACE_HUNT_PROFILE}${hasExplicitTraceIds ? " (explicit trace IDs override profile)" : ""}`);
console.log(`Trace count: ${traceIds.length}`);
console.log(`Coverage tags: ${coverageTags(traceIds).join(", ") || "unknown"}`);
if (hasExplicitTraceIds || process.env.RUNTIME_TRACE_HUNT_SHOW_TRACE_IDS === "1") {
  console.log(`Trace IDs: ${traceIds.join(", ")}`);
}

const deadline = Date.now() + CORPUS_RUN_CAP_MS;
let runs = 0;
let failures = 0;
let duplicateFailures = 0;
let newFindings = 0;
let lastTraceId = traceIds[0] ?? "";
let completedCorpus = false;

console.log(`\nRunning ${traceIds.length} domain trace(s) once`);

for (const traceId of traceIds) {
  if (Date.now() + MIN_RUN_BUDGET_MS > deadline) {
    console.log(`Trace ${traceId} skipped at the corpus run boundary.`);
    break;
  }

  lastTraceId = traceId;
  runs += 1;
  const result = await runTrace(traceId, Math.max(MIN_RUN_BUDGET_MS, deadline - Date.now()));
  if (result.timedOut) {
    console.log(`Trace ${traceId} timed out at the corpus run boundary.`);
    break;
  }
  if (result.code === 0) {
    completedCorpus = traceId === traceIds.at(-1);
    continue;
  }

  failures += 1;
  const finding = parseFinding(traceId, result.output);
  if (!finding) {
    const fallback = {
      traceId,
      message: `vitest exited with code ${result.code}`,
      trace: excerpt(result.output, 80),
      signature: `unparsed failure:${result.code}:${traceId}`,
      replay: replayCommand(traceId)
    };
    if (recordFinding(BUG_FILE, bugLog, fallback)) {
      newFindings += 1;
      console.log(`New unparsed finding in ${traceId}: ${fallback.message}`);
    } else {
      duplicateFailures += 1;
    }
    completedCorpus = traceId === traceIds.at(-1);
    continue;
  }

  if (recordFinding(BUG_FILE, bugLog, finding)) {
    newFindings += 1;
    console.log(`New finding in ${traceId}: ${finding.message}`);
  } else {
    duplicateFailures += 1;
  }
  completedCorpus = traceId === traceIds.at(-1);
}

appendCorpusRunSummary(BUG_FILE, {
  mode: "agent-corpus-run",
  profile: TRACE_HUNT_PROFILE,
  coverageTags: coverageTags(traceIds),
  firstTraceId: traceIds[0] ?? "",
  lastTraceId,
  runs,
  completedCorpus,
  failures,
  duplicateFailures,
  newFindings
});

console.log(
  `Corpus run done: ${runs} run(s), ${failures} failure(s), ${newFindings} new finding(s), ` +
    `${duplicateFailures} duplicate failure(s), completed corpus: ${completedCorpus ? "yes" : "no"}.`
);

async function runTrace(traceId, timeoutMs) {
  const child = spawn(process.platform === "win32" ? "pnpm.cmd" : "pnpm", [
    "exec",
    "vitest",
    "run",
    TEST_FILE,
    "--testNamePattern",
    TEST_NAME,
    "--reporter=dot"
  ], {
    env: {
      ...process.env,
      RUNTIME_TRACE_HUNT_PROFILE: TRACE_HUNT_PROFILE,
      RUNTIME_DOMAIN_TRACE_HUNT: "1",
      RUNTIME_TRACE_HUNT_TRACE_IDS: traceId
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  return await new Promise((resolve) => {
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output, timedOut });
    });
  });
}

function parseFinding(traceId, output) {
  const message = output.match(/Error: ([^\n]+)/)?.[1]?.trim();
  const domainTraceId = output.match(/Domain trace: ([^\n]+)/)?.[1]?.trim() ?? traceId;
  const action = output.match(/Action \d+: ([^\n]+)/)?.[0]?.trim() ?? "";
  const trace = output.match(/Trace:\n([\s\S]*?)(?:\n ❯|\n\n⎯)/)?.[1]?.trim();
  if (!message || !trace) {
    return undefined;
  }

  const traceLines = trace.split("\n").map((line) => line.trim()).filter(Boolean);
  const actionLine = findLast(traceLines, (line) => line.startsWith("action ")) ?? action;
  const signature = [
    normalizeTraceSignaturePart(message),
    `domain trace: ${domainTraceId}`,
    normalizeTraceSignaturePart(actionLine)
  ].join("\n");
  return {
    traceId: domainTraceId,
    message,
    trace,
    signature,
    replay: replayCommand(domainTraceId)
  };
}

function recordFinding(file, log, finding) {
  if (log.signatures.has(finding.signature)) {
    return false;
  }

  const id = `RT-${String(log.nextId).padStart(3, "0")}`;
  log.nextId += 1;
  log.signatures.add(finding.signature);

  append(file, `
### ${id} ${finding.message}
<!-- signature: ${escapeHtmlComment(finding.signature)} -->

- First seen: ${new Date().toISOString()}
- Trace id: \`${finding.traceId}\`
- Repro: \`${finding.replay}\`
- Status: documented, not fixed.

\`\`\`text
${finding.trace}
\`\`\`
`);

  return true;
}

function appendCorpusRunSummary(file, summary) {
  append(file, `
<!-- hunt-corpus-run: ${JSON.stringify({
    at: new Date().toISOString(),
    ...summary
  })} -->
`);
}

function replayCommand(traceId) {
  return `env RUNTIME_DOMAIN_TRACE_HUNT=1 RUNTIME_TRACE_HUNT_TRACE_IDS=${traceId} pnpm exec vitest run ${TEST_FILE} --testNamePattern "${TEST_NAME}" --reporter=dot`;
}

function ensureBugLogFile(file) {
  if (existsSync(file)) {
    return;
  }

  writeFileSync(file, `# Runtime Trace Bug Hunt

This file records distinct bugs found by deterministic adversarial runtime domain traces.
The hunt intentionally documents findings without fixing them.

Run the hunt with:

\`\`\`sh
pnpm trace-hunt:runtime
\`\`\`

Default hunt bounds:

- Corpus run cap: 5 minutes
- Agent stop condition: 3 full 5-minute discovery mutation blocks with no new distinct findings
- Trace selection: default profile is \`discovery\`; use \`RUNTIME_TRACE_HUNT_PROFILE=regression|all\` for known repro replay, or \`RUNTIME_TRACE_HUNT_TRACE_IDS=...\` for explicit traces
- Corpus semantics: execute the selected explicit domain trace corpus once, recording every distinct failure; Codex/humans mutate discovery trace actions between runs, not seeds
- Test target: \`${TEST_FILE}\`
- Test name: \`${TEST_NAME}\`

## Findings
`);
}

function loadBugLog(file) {
  if (!existsSync(file)) {
    return { signatures: new Set(), nextId: 1 };
  }

  const text = readFileSync(file, "utf8");
  const signatures = new Set(
    [...text.matchAll(/<!-- signature: ([\s\S]*?) -->/g)].map((match) => unescapeHtmlComment(match[1] ?? ""))
  );
  const ids = [...text.matchAll(/^### RT-(\d+)/gm)].map((match) => Number(match[1]));
  return {
    signatures,
    nextId: ids.length > 0 ? Math.max(...ids) + 1 : 1
  };
}

function selectedTraceIds() {
  const rawTraceIds = process.env.RUNTIME_TRACE_HUNT_TRACE_IDS;
  if (!rawTraceIds) {
    if (TRACE_HUNT_PROFILE === "discovery") {
      return DISCOVERY_TRACE_IDS;
    }
    if (TRACE_HUNT_PROFILE === "regression") {
      return REGRESSION_TRACE_IDS;
    }
    return ALL_TRACE_IDS;
  }
  return rawTraceIds
    .split(",")
    .map((traceId) => traceId.trim())
    .filter(Boolean);
}

function traceHuntProfile() {
  const profile = process.env.RUNTIME_TRACE_HUNT_PROFILE ?? "discovery";
  if (profile === "discovery" || profile === "regression" || profile === "all") {
    return profile;
  }
  throw new Error(`RUNTIME_TRACE_HUNT_PROFILE must be discovery, regression, or all; got ${JSON.stringify(profile)}`);
}

function coverageTags(traceIds) {
  return [...new Set(traceIds.flatMap((traceId) => TRACE_TAGS.get(traceId) ?? ["unknown"]))]
    .sort();
}

function append(file, text) {
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  writeFileSync(file, `${current}${text}`);
}

function excerpt(text, maxLines) {
  return text.split("\n").slice(0, maxLines).join("\n").trim();
}

function escapeHtmlComment(value) {
  return value.replaceAll("--", "- -");
}

function unescapeHtmlComment(value) {
  return value.replaceAll("- -", "--");
}

function findLast(values, predicate) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index], index)) {
      return values[index];
    }
  }
  return undefined;
}

function normalizeTraceSignaturePart(value) {
  return value
    .replace(/^action \d+:/, "action:")
    .replace(/\bseed \d+\b/g, "seed <id>")
    .replace(/\btab \d+\b/g, "tab <id>")
    .replace(/\bwindow \d+\b/g, "window <id>")
    .replace(/\bgroup:\d+\b/g, "group:<id>")
    .replace(/\btab:\d+\b/g, "tab:<id>")
    .replace(/\bwindow:\d+\b/g, "window:<id>");
}

function positiveIntegerEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}
