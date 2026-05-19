import { summarizeTraceEvents, type TraceSnapshot, type TraceSummaryRow } from "./trace.js";

export const PROFILE_STORAGE_KEY = "tabsOutlinerProfileEnabled";
export const PERFORMANCE_PROFILE_SCHEMA = "tabs-outliner-profile";

export type LabeledTraceSnapshot = {
  id: string;
  label: string;
  snapshot: TraceSnapshot;
  windowId?: number;
  url?: string;
};

export type PerformanceProfileSources = {
  background?: TraceSnapshot;
  sidebar?: TraceSnapshot;
  sidebars?: LabeledTraceSnapshot[];
};

export type PerformanceProfileSnapshot = PerformanceProfileSources & {
  background: TraceSnapshot;
};

export type SidebarProfileSnapshot = PerformanceProfileSources & {
  sidebar: TraceSnapshot;
};

export type PerformanceProfileExport = {
  schema: typeof PERFORMANCE_PROFILE_SCHEMA;
  exportedAt: string;
  snapshot: PerformanceProfileSources;
  summary: TraceSummaryRow[];
};

export function summarizePerformanceProfile(snapshot: PerformanceProfileSources): TraceSummaryRow[] {
  return summarizeTraceEvents([
    ...(snapshot.background?.entries ?? []),
    ...sidebarTraceSnapshots(snapshot).flatMap((sidebar) => sidebar.entries)
  ]);
}

export function performanceProfileEntryCount(snapshot: PerformanceProfileSources): number {
  return (snapshot.background?.entries.length ?? 0) +
    sidebarTraceSnapshots(snapshot).reduce((sum, sidebar) => sum + sidebar.entries.length, 0);
}

export function performanceProfileEnabled(snapshot: PerformanceProfileSources): boolean {
  return Boolean(snapshot.background?.enabled || sidebarTraceSnapshots(snapshot).some((sidebar) => sidebar.enabled));
}

export function createPerformanceProfileExport(
  snapshot: PerformanceProfileSources,
  options: { now?: number | Date } = {}
): PerformanceProfileExport {
  return {
    schema: PERFORMANCE_PROFILE_SCHEMA,
    exportedAt: new Date(options.now ?? Date.now()).toISOString(),
    snapshot,
    summary: summarizePerformanceProfile(snapshot)
  };
}

export function performanceProfileFilename(date = new Date()): string {
  return `tabs-outliner-profile-${localDateSlug(date)}.json`;
}

export function downloadPerformanceProfileExport(
  payload: PerformanceProfileExport,
  options: { date?: Date } = {}
): void {
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = performanceProfileFilename(options.date);
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function isTraceSnapshot(value: unknown): value is TraceSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const snapshot = value as { enabled?: unknown; maxEntries?: unknown; entries?: unknown };
  return typeof snapshot.enabled === "boolean" &&
    typeof snapshot.maxEntries === "number" &&
    Array.isArray(snapshot.entries);
}

export function isLabeledTraceSnapshot(value: unknown): value is LabeledTraceSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const snapshot = value as {
    id?: unknown;
    label?: unknown;
    snapshot?: unknown;
    windowId?: unknown;
    url?: unknown;
  };
  return typeof snapshot.id === "string" &&
    typeof snapshot.label === "string" &&
    isTraceSnapshot(snapshot.snapshot) &&
    (snapshot.windowId === undefined || typeof snapshot.windowId === "number") &&
    (snapshot.url === undefined || typeof snapshot.url === "string");
}

export function isPerformanceProfileSnapshot(value: unknown): value is PerformanceProfileSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const snapshot = value as { background?: unknown; sidebar?: unknown; sidebars?: unknown };
  return isTraceSnapshot(snapshot.background) &&
    (snapshot.sidebar === undefined || isTraceSnapshot(snapshot.sidebar)) &&
    (snapshot.sidebars === undefined ||
      (Array.isArray(snapshot.sidebars) && snapshot.sidebars.every(isLabeledTraceSnapshot)));
}

function sidebarTraceSnapshots(snapshot: PerformanceProfileSources): TraceSnapshot[] {
  if (snapshot.sidebars) {
    return snapshot.sidebars.map((sidebar) => sidebar.snapshot);
  }
  return snapshot.sidebar ? [snapshot.sidebar] : [];
}

function localDateSlug(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
