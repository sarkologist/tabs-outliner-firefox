import type { RestoreCreateAttempt, RuntimeClosePlan } from "./commands.js";
import type { HistoryEntry, HistoryState, OutlineDelta } from "./history.js";
import type { NodeId } from "../model/types.js";

export const RUNTIME_LIFECYCLE_JOURNAL_KEY = "runtimeLifecycleJournal:v1";

const RUNTIME_LIFECYCLE_JOURNAL_VERSION = 1;
const RUNTIME_LIFECYCLE_JOURNAL_LIMIT = 32;

export type RuntimeLifecycleJournalEntry =
  | {
      version: 1;
      id: string;
      createdAt: number;
      kind: "closeNode";
      nodeId: NodeId;
      plan: RuntimeClosePlan;
    }
  | {
      version: 1;
      id: string;
      createdAt: number;
      kind: "deleteNode";
      nodeId: NodeId;
      plan: RuntimeClosePlan;
    }
  | {
      version: 1;
      id: string;
      createdAt: number;
      kind: "restoreNode";
      nodeId: NodeId;
      before: {
        tabIds: number[];
        windowIds: number[];
      };
      attempts: RestoreCreateAttempt[];
    }
  | {
      version: 1;
      id: string;
      createdAt: number;
      kind: "relocation";
      commandType:
        | "moveNode"
        | "moveNodeToNewWindow"
        | "wrapNodeInGroup"
        | "moveSubtreeToTopLevel"
        | "moveSubtreeToBottomTopLevel";
      nodeId: NodeId;
      tabId: number;
      sourceWindowId: number;
      rootIndex?: number;
    }
  | {
      version: 1;
      id: string;
      createdAt: number;
      kind: "history";
      direction: "undo" | "redo";
      entry: HistoryEntry;
      poppedHistory: HistoryState;
      delta: OutlineDelta;
    }
  | {
      version: 1;
      id: string;
      createdAt: number;
      kind: "nativeTabClose";
      tabId: number;
      windowId?: number;
      plan: RuntimeClosePlan;
    }
  | {
      version: 1;
      id: string;
      createdAt: number;
      kind: "nativeWindowClose";
      windowId: number;
      plan: RuntimeClosePlan;
      sessionId?: string;
    };

export type RuntimeLifecycleJournal = {
  version: 1;
  entries: RuntimeLifecycleJournalEntry[];
};

export function emptyRuntimeLifecycleJournal(): RuntimeLifecycleJournal {
  return {
    version: RUNTIME_LIFECYCLE_JOURNAL_VERSION,
    entries: []
  };
}

export async function loadRuntimeLifecycleJournal(
  api: WebExtensionBrowser
): Promise<RuntimeLifecycleJournal> {
  const stored = await api.storage.local.get(RUNTIME_LIFECYCLE_JOURNAL_KEY);
  return normalizeRuntimeLifecycleJournal(stored[RUNTIME_LIFECYCLE_JOURNAL_KEY]);
}

export async function appendRuntimeLifecycleJournalEntry(
  api: WebExtensionBrowser,
  entry: RuntimeLifecycleJournalEntry
): Promise<void> {
  const journal = await loadRuntimeLifecycleJournal(api);
  await saveRuntimeLifecycleJournal(api, {
    version: RUNTIME_LIFECYCLE_JOURNAL_VERSION,
    entries: [...journal.entries.filter((candidate) => candidate.id !== entry.id), entry]
      .slice(-RUNTIME_LIFECYCLE_JOURNAL_LIMIT)
  });
}

export async function replaceRuntimeLifecycleJournalEntry(
  api: WebExtensionBrowser,
  entry: RuntimeLifecycleJournalEntry
): Promise<void> {
  const journal = await loadRuntimeLifecycleJournal(api);
  const entries = journal.entries.some((candidate) => candidate.id === entry.id)
    ? journal.entries.map((candidate) => candidate.id === entry.id ? entry : candidate)
    : [...journal.entries, entry];
  await saveRuntimeLifecycleJournal(api, {
    version: RUNTIME_LIFECYCLE_JOURNAL_VERSION,
    entries: entries.slice(-RUNTIME_LIFECYCLE_JOURNAL_LIMIT)
  });
}

export async function clearRuntimeLifecycleJournalEntries(
  api: WebExtensionBrowser,
  entryIds: readonly string[]
): Promise<void> {
  if (entryIds.length === 0) {
    return;
  }

  const ids = new Set(entryIds);
  const journal = await loadRuntimeLifecycleJournal(api);
  const entries = journal.entries.filter((entry) => !ids.has(entry.id));
  if (entries.length === 0) {
    await api.storage.local.remove(RUNTIME_LIFECYCLE_JOURNAL_KEY);
    return;
  }
  await saveRuntimeLifecycleJournal(api, {
    version: RUNTIME_LIFECYCLE_JOURNAL_VERSION,
    entries
  });
}

async function saveRuntimeLifecycleJournal(
  api: WebExtensionBrowser,
  journal: RuntimeLifecycleJournal
): Promise<void> {
  await api.storage.local.set({
    [RUNTIME_LIFECYCLE_JOURNAL_KEY]: journal
  });
}

function normalizeRuntimeLifecycleJournal(value: unknown): RuntimeLifecycleJournal {
  if (!value || typeof value !== "object") {
    return emptyRuntimeLifecycleJournal();
  }
  const candidate = value as { version?: unknown; entries?: unknown };
  if (candidate.version !== RUNTIME_LIFECYCLE_JOURNAL_VERSION || !Array.isArray(candidate.entries)) {
    return emptyRuntimeLifecycleJournal();
  }

  return {
    version: RUNTIME_LIFECYCLE_JOURNAL_VERSION,
    entries: candidate.entries.filter(isRuntimeLifecycleJournalEntry).slice(-RUNTIME_LIFECYCLE_JOURNAL_LIMIT)
  };
}

function isRuntimeLifecycleJournalEntry(value: unknown): value is RuntimeLifecycleJournalEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as RuntimeLifecycleJournalEntry;
  if (entry.version !== RUNTIME_LIFECYCLE_JOURNAL_VERSION || typeof entry.id !== "string" || typeof entry.createdAt !== "number") {
    return false;
  }
  if (entry.kind === "closeNode" || entry.kind === "deleteNode") {
    return typeof entry.nodeId === "string" && isRuntimeClosePlan(entry.plan);
  }
  if (entry.kind === "restoreNode") {
    return typeof entry.nodeId === "string" &&
      Array.isArray(entry.before?.tabIds) &&
      Array.isArray(entry.before?.windowIds) &&
      Array.isArray(entry.attempts);
  }
  if (entry.kind === "relocation") {
    return typeof entry.nodeId === "string" &&
      typeof entry.tabId === "number" &&
      typeof entry.sourceWindowId === "number";
  }
  if (entry.kind === "history") {
    return (entry.direction === "undo" || entry.direction === "redo") &&
      Boolean(entry.entry) &&
      Boolean(entry.poppedHistory) &&
      Boolean(entry.delta);
  }
  if (entry.kind === "nativeTabClose") {
    return typeof entry.tabId === "number" &&
      (entry.windowId === undefined || typeof entry.windowId === "number") &&
      isRuntimeClosePlan(entry.plan);
  }
  if (entry.kind === "nativeWindowClose") {
    return typeof entry.windowId === "number" &&
      isRuntimeClosePlan(entry.plan) &&
      (entry.sessionId === undefined || typeof entry.sessionId === "string");
  }
  return false;
}

function isRuntimeClosePlan(value: unknown): value is RuntimeClosePlan {
  if (!value || typeof value !== "object") {
    return false;
  }
  const plan = value as RuntimeClosePlan;
  return Array.isArray(plan.tabIds) &&
    plan.tabIds.every((tabId) => typeof tabId === "number") &&
    Array.isArray(plan.windowIds) &&
    plan.windowIds.every((windowId) => typeof windowId === "number");
}
