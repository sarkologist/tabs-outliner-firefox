export const INCIDENT_LOG_STORAGE_KEY = "tabsOutlinerIncidentLog:v1";
export const INCIDENT_LOG_LIMIT = 100;

const INCIDENT_LOG_VERSION = 1;

export type IncidentLogDetailValue = string | number | boolean | null | undefined;
export type IncidentLogDetail = Record<string, IncidentLogDetailValue>;

export type IncidentLogEntry = {
  version: 1;
  at: string;
  event: string;
  detail?: Record<string, string | number | boolean | null>;
};

type StoredIncidentLog = {
  version: 1;
  entries: IncidentLogEntry[];
};

let appendQueue = Promise.resolve();

// One in-memory copy of the log per writer context (keyed by the storage api so
// tests stay isolated). The background page is the only writer, so the cache stays
// authoritative and lets appends do a single `set` with no per-append `get`.
const cachedEntriesByApi = new WeakMap<WebExtensionBrowser, IncidentLogEntry[]>();

export async function loadIncidentLog(api: WebExtensionBrowser = browser): Promise<IncidentLogEntry[]> {
  const stored = await api.storage.local.get(INCIDENT_LOG_STORAGE_KEY);
  return normalizeIncidentLog(stored[INCIDENT_LOG_STORAGE_KEY]).entries;
}

async function ensureCachedEntries(api: WebExtensionBrowser): Promise<IncidentLogEntry[]> {
  const existing = cachedEntriesByApi.get(api);
  if (existing) {
    return existing;
  }
  const stored = await api.storage.local.get(INCIDENT_LOG_STORAGE_KEY);
  const entries = normalizeIncidentLog(stored[INCIDENT_LOG_STORAGE_KEY]).entries;
  cachedEntriesByApi.set(api, entries);
  return entries;
}

export async function appendIncidentLogEntry(
  api: WebExtensionBrowser,
  event: string,
  detail: IncidentLogDetail = {},
  options: { now?: () => number; limit?: number } = {}
): Promise<void> {
  appendQueue = appendQueue.then(
    () => appendIncidentLogEntryNow(api, event, detail, options),
    () => appendIncidentLogEntryNow(api, event, detail, options)
  );
  return appendQueue;
}

async function appendIncidentLogEntryNow(
  api: WebExtensionBrowser,
  event: string,
  detail: IncidentLogDetail,
  options: { now?: () => number; limit?: number }
): Promise<void> {
  const limit = options.limit ?? INCIDENT_LOG_LIMIT;
  const cached = await ensureCachedEntries(api);
  const normalized = normalizedDetail(detail);
  const entry: IncidentLogEntry = {
    version: INCIDENT_LOG_VERSION,
    at: new Date((options.now ?? Date.now)()).toISOString(),
    event
  };
  if (normalized) {
    entry.detail = normalized;
  }
  const nextEntries = [...cached, entry].slice(-limit);
  await api.storage.local.set({
    [INCIDENT_LOG_STORAGE_KEY]: {
      version: INCIDENT_LOG_VERSION,
      entries: nextEntries
    }
  });
  // Update the cache only after the write lands: a rejected set must not leave a phantom
  // entry in memory that the next successful append would then persist.
  cachedEntriesByApi.set(api, nextEntries);
}

function normalizeIncidentLog(value: unknown): StoredIncidentLog {
  if (!value || typeof value !== "object") {
    return emptyIncidentLog();
  }
  const candidate = value as { version?: unknown; entries?: unknown };
  if (candidate.version !== INCIDENT_LOG_VERSION || !Array.isArray(candidate.entries)) {
    return emptyIncidentLog();
  }
  return {
    version: INCIDENT_LOG_VERSION,
    entries: candidate.entries.flatMap(normalizeIncidentLogEntry).slice(-INCIDENT_LOG_LIMIT)
  };
}

function emptyIncidentLog(): StoredIncidentLog {
  return {
    version: INCIDENT_LOG_VERSION,
    entries: []
  };
}

function normalizeIncidentLogEntry(value: unknown): IncidentLogEntry[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const entry = value as { version?: unknown; at?: unknown; event?: unknown; detail?: unknown };
  if (entry.version !== INCIDENT_LOG_VERSION || typeof entry.at !== "string" || typeof entry.event !== "string") {
    return [];
  }
  const normalized = entry.detail && typeof entry.detail === "object" && !Array.isArray(entry.detail)
    ? normalizedDetail(entry.detail as Record<string, unknown>)
    : undefined;
  const result: IncidentLogEntry = {
    version: INCIDENT_LOG_VERSION,
    at: entry.at,
    event: entry.event
  };
  if (normalized) {
    result.detail = normalized;
  }
  return [result];
}

function normalizedDetail(detail: Record<string, unknown>): IncidentLogEntry["detail"] | undefined {
  const normalized = Object.fromEntries(
    Object.entries(detail).filter((entry): entry is [string, string | number | boolean | null] =>
      isIncidentLogDetailStoredValue(entry[1])
    )
  );
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function isIncidentLogDetailStoredValue(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}
