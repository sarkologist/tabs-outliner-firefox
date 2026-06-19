import type { NodeId, RuntimeTab } from "../model/types.js";
import { isLabeledTraceSnapshot, type LabeledTraceSnapshot } from "../perf/profile.js";

// Background message-router message shapes + runtime type-guards, extracted from controller.ts
// (no behavior change). Pure predicates over `unknown` incoming messages.

export type PerformanceTraceMessage =
  | {
      type: "setPerformanceTraceEnabled";
      enabled: boolean;
    }
  | {
      type: "clearPerformanceTrace";
    }
  | {
      type: "getPerformanceTrace";
    }
  | {
      type: "getPerformanceProfile";
    };

export type SidebarPerformanceTraceCollectedMessage = {
  type: "sidebarPerformanceTraceCollected";
  requestId: string;
  sidebar: LabeledTraceSnapshot;
};

export type InitialTreeSnapshotMessage = {
  type: "getInitialTreeSnapshot";
};

export type InitialTreeSnapshotWindowMessage = {
  type: "getInitialTreeSnapshotWindow" | "getTreeProjectionSlice";
  centerRowIndex: number;
  rowLimit?: number;
  query?: string;
  targetNodeId?: NodeId;
};

export type OpenSidebarWindowMessage = {
  type: "openSidebarWindow";
  // The window the click came from (the sidebar's own window id). When it is itself a tracked
  // full-size sidebar window, the background spawns another instance; otherwise it switches to the
  // most recently focused existing full-size sidebar. Optional for backward compatibility.
  sourceWindowId?: number;
};

export type OpenImportViewerWindowMessage = {
  type: "openImportViewerWindow";
};

export type ExportTreeMessage = {
  type: "exportTree";
};

export type SidebarNonEditInteractionMessage = {
  type: "sidebarNonEditInteraction";
};

export function isDiagnosticsRequest(message: unknown): message is { type: "getDiagnostics" } {
  return Boolean(
    message &&
    typeof message === "object" &&
    (message as { type?: unknown }).type === "getDiagnostics"
  );
}

export function isIncidentLogRequest(message: unknown): message is { type: "getIncidentLog" } {
  return Boolean(
    message &&
    typeof message === "object" &&
    (message as { type?: unknown }).type === "getIncidentLog"
  );
}

export function isInitialTreeSnapshotMessage(
  message: unknown
): message is InitialTreeSnapshotMessage {
  return Boolean(
    message &&
    typeof message === "object" &&
    (message as { type?: unknown }).type === "getInitialTreeSnapshot"
  );
}

export function isInitialTreeSnapshotWindowMessage(
  message: unknown
): message is InitialTreeSnapshotWindowMessage {
  return Boolean(
    message &&
    typeof message === "object" &&
    ((message as { type?: unknown }).type === "getInitialTreeSnapshotWindow" ||
      (message as { type?: unknown }).type === "getTreeProjectionSlice") &&
    typeof (message as { centerRowIndex?: unknown }).centerRowIndex === "number" &&
    Number.isFinite((message as { centerRowIndex?: number }).centerRowIndex) &&
    ((message as { targetNodeId?: unknown }).targetNodeId === undefined ||
      typeof (message as { targetNodeId?: unknown }).targetNodeId === "string") &&
    ((message as { query?: unknown }).query === undefined ||
      typeof (message as { query?: unknown }).query === "string")
  );
}

export function isOpenSidebarWindowMessage(message: unknown): message is OpenSidebarWindowMessage {
  return Boolean(
    message &&
    typeof message === "object" &&
    (message as { type?: unknown }).type === "openSidebarWindow"
  );
}

export function isOpenImportViewerWindowMessage(
  message: unknown
): message is OpenImportViewerWindowMessage {
  return Boolean(
    message &&
    typeof message === "object" &&
    (message as { type?: unknown }).type === "openImportViewerWindow"
  );
}

export function isExportTreeMessage(message: unknown): message is ExportTreeMessage {
  return Boolean(
    message && typeof message === "object" && (message as { type?: unknown }).type === "exportTree"
  );
}

export function isSidebarNonEditInteractionMessage(
  message: unknown
): message is SidebarNonEditInteractionMessage {
  return Boolean(
    message &&
    typeof message === "object" &&
    (message as { type?: unknown }).type === "sidebarNonEditInteraction"
  );
}

export function isPerformanceTraceMessage(message: unknown): message is PerformanceTraceMessage {
  if (!message || typeof message !== "object") {
    return false;
  }

  const type = (message as { type?: unknown }).type;
  return (
    type === "getPerformanceTrace" ||
    type === "getPerformanceProfile" ||
    type === "clearPerformanceTrace" ||
    (type === "setPerformanceTraceEnabled" &&
      typeof (message as { enabled?: unknown }).enabled === "boolean")
  );
}

export function isSidebarPerformanceTraceCollectedMessage(
  message: unknown
): message is SidebarPerformanceTraceCollectedMessage {
  if (!message || typeof message !== "object") {
    return false;
  }
  const candidate = message as { type?: unknown; requestId?: unknown; sidebar?: unknown };
  return (
    candidate.type === "sidebarPerformanceTraceCollected" &&
    typeof candidate.requestId === "string" &&
    isLabeledTraceSnapshot(candidate.sidebar)
  );
}

export function messageType(message: unknown): string {
  return message &&
    typeof message === "object" &&
    typeof (message as { type?: unknown }).type === "string"
    ? (message as { type: string }).type
    : "unknown";
}

export function hasOutlineRelevantTabUpdate(changeInfo: Partial<RuntimeTab>): boolean {
  return Boolean(
    "active" in changeInfo ||
    "favIconUrl" in changeInfo ||
    "title" in changeInfo ||
    "url" in changeInfo
  );
}
