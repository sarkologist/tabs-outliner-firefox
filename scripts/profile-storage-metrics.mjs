export const RUNTIME_LIFECYCLE_JOURNAL_KEY = "runtimeLifecycleJournal:v1";

export function createStorageMetrics() {
  return {
    saves: 0,
    stateSaves: 0,
    journalWrites: 0,
    storageSetCalls: 0,
    saveStringifyMs: 0,
    stateSaveStringifyMs: 0,
    journalStringifyMs: 0,
    bytes: 0,
    stateSaveBytes: 0,
    journalBytes: 0
  };
}

export function resetStorageMetrics(runtime) {
  Object.assign(runtime, createStorageMetrics());
}

export function recordProfileStorageSet(runtime, items, measure) {
  const measured = measure(() => JSON.stringify(items));
  runtime.storageSetCalls += 1;
  runtime.saveStringifyMs += measured.ms;
  runtime.bytes += measured.value.length;

  if (isJournalOnlySet(items)) {
    runtime.journalWrites += 1;
    runtime.journalStringifyMs += measured.ms;
    runtime.journalBytes += measured.value.length;
    return;
  }

  runtime.saves += 1;
  runtime.stateSaves += 1;
  runtime.stateSaveStringifyMs += measured.ms;
  runtime.stateSaveBytes += measured.value.length;
}

export function storageMetricsResult(runtime) {
  return {
    saves: runtime.saves,
    stateSaves: runtime.stateSaves,
    journalWrites: runtime.journalWrites,
    storageSetCalls: runtime.storageSetCalls,
    saveStringifyMs: Math.round(runtime.saveStringifyMs),
    stateSaveStringifyMs: Math.round(runtime.stateSaveStringifyMs),
    journalStringifyMs: Math.round(runtime.journalStringifyMs),
    mbStringified: Math.round(runtime.bytes / 1024 / 1024),
    stateSaveMbStringified: Math.round(runtime.stateSaveBytes / 1024 / 1024),
    journalKbStringified: Math.round(runtime.journalBytes / 1024)
  };
}

export function createBroadcastMetrics() {
  return {
    broadcasts: 0,
    stateBroadcasts: 0,
    statusBroadcasts: 0
  };
}

export function resetBroadcastMetrics(runtime) {
  Object.assign(runtime, createBroadcastMetrics());
}

export function recordProfileBroadcast(runtime, message) {
  runtime.broadcasts += 1;
  if (message?.type === "historyStatus") {
    runtime.statusBroadcasts += 1;
  } else {
    runtime.stateBroadcasts += 1;
  }
}

export function broadcastMetricsResult(runtime) {
  return {
    broadcasts: runtime.broadcasts,
    stateBroadcasts: runtime.stateBroadcasts,
    statusBroadcasts: runtime.statusBroadcasts
  };
}

function isJournalOnlySet(items) {
  if (!items || typeof items !== "object" || Array.isArray(items)) {
    return false;
  }
  const keys = Object.keys(items);
  return keys.length === 1 && keys[0] === RUNTIME_LIFECYCLE_JOURNAL_KEY;
}
