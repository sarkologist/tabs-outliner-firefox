import { isLiveTabNode } from "../model/live-nodes.js";
import type { NodeId, OutlineState, RuntimeTab, RuntimeWindow } from "../model/types.js";

// A live Firefox tab that has no live tab node in the outline -- it is what the "missing N"
// readout counts. The window/url/title are carried alongside the id so the tab can be
// identified after the fact: the live readout is volatile, but the diagnostics coordinator
// records these into the incident log, which a profile export captures.
export type MissingRuntimeTab = {
  id: number;
  windowId: number;
  url?: string;
  title?: string;
};

export type OutlineDiagnostics = {
  runtimeTabCount: number;
  liveTabNodeCount: number;
  visibleLiveTabNodeCount: number;
  closedTabNodeCount: number;
  hiddenLiveTabNodeCount: number;
  missingRuntimeTabIds: number[];
  missingRuntimeTabs: MissingRuntimeTab[];
};

export function computeDiagnostics(
  state: OutlineState,
  runtimeWindows: RuntimeWindow[]
): OutlineDiagnostics {
  // Keep the runtime tab behind its id (ids are unique across windows; the has-guard only
  // defends against a duplicate in a malformed snapshot) so the missing list can carry each
  // tab's window/url/title, not just its id.
  const runtimeTabsById = new Map<number, RuntimeTab>();
  for (const windowInfo of runtimeWindows) {
    for (const tab of windowInfo.tabs ?? []) {
      if (!runtimeTabsById.has(tab.id)) {
        runtimeTabsById.set(tab.id, tab);
      }
    }
  }
  const liveTabIds = new Set<number>();
  let liveTabNodeCount = 0;
  let closedTabNodeCount = 0;

  for (const node of Object.values(state.nodes)) {
    if (node.kind !== "tab") {
      continue;
    }

    if (isLiveTabNode(node)) {
      liveTabNodeCount += 1;
      liveTabIds.add(node.live.tabId);
    } else if (node.status === "closed") {
      closedTabNodeCount += 1;
    }
  }

  const visibleLiveTabNodeCount = countVisibleLiveTabs(state);
  const missingRuntimeTabs: MissingRuntimeTab[] = [...runtimeTabsById.values()]
    .filter((tab) => !liveTabIds.has(tab.id))
    .sort((a, b) => a.id - b.id)
    .map((tab) => {
      // Add url/title only when present: exactOptionalPropertyTypes forbids an explicit
      // undefined on the optional fields.
      const missing: MissingRuntimeTab = { id: tab.id, windowId: tab.windowId };
      if (tab.url !== undefined) {
        missing.url = tab.url;
      }
      if (tab.title !== undefined) {
        missing.title = tab.title;
      }
      return missing;
    });

  return {
    runtimeTabCount: runtimeTabsById.size,
    liveTabNodeCount,
    visibleLiveTabNodeCount,
    closedTabNodeCount,
    hiddenLiveTabNodeCount: liveTabNodeCount - visibleLiveTabNodeCount,
    missingRuntimeTabIds: missingRuntimeTabs.map((tab) => tab.id),
    missingRuntimeTabs
  };
}

// One "missingRuntimeTab" incident-log entry must stay small: the log is a bounded ring and
// each append rewrites the whole key. So cap the number of tabs serialized AND cap each
// url/title, so a single pathological value (e.g. a long data: URL) cannot bloat the entry.
// The recorded missingCount carries the true total and a trailing "…" marks a truncated
// field, so neither cap is a silent loss.
export const MISSING_RUNTIME_TAB_LOG_LIMIT = 25;
const MISSING_RUNTIME_TAB_FIELD_MAX_CHARS = 256;

export function serializeMissingRuntimeTabsForIncidentLog(missing: MissingRuntimeTab[]): string {
  return JSON.stringify(
    missing.slice(0, MISSING_RUNTIME_TAB_LOG_LIMIT).map((tab) => {
      const entry: MissingRuntimeTab = { id: tab.id, windowId: tab.windowId };
      if (tab.url !== undefined) {
        entry.url = truncateIncidentField(tab.url);
      }
      if (tab.title !== undefined) {
        entry.title = truncateIncidentField(tab.title);
      }
      return entry;
    })
  );
}

function truncateIncidentField(value: string): string {
  return value.length > MISSING_RUNTIME_TAB_FIELD_MAX_CHARS
    ? `${value.slice(0, MISSING_RUNTIME_TAB_FIELD_MAX_CHARS)}…`
    : value;
}

function countVisibleLiveTabs(state: OutlineState): number {
  let count = 0;
  const visited = new Set<NodeId>();
  const stack = [...state.rootIds].reverse();

  while (stack.length > 0) {
    const nodeId = stack.pop()!;
    if (visited.has(nodeId)) {
      continue;
    }
    visited.add(nodeId);

    const node = state.nodes[nodeId];
    if (!node) {
      continue;
    }

    if (isLiveTabNode(node)) {
      count += 1;
    }
    if (node.collapsed) {
      continue;
    }

    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      stack.push(node.childIds[index]!);
    }
  }

  return count;
}
