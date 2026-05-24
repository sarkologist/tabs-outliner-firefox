export type NodeId = string;

export type RuntimeTab = {
  id: number;
  windowId: number;
  index: number;
  active: boolean;
  openerTabId?: number;
  url?: string;
  title?: string;
  favIconUrl?: string;
  incognito?: boolean;
  sessionId?: string;
  discarded?: boolean;
  hidden?: boolean;
};

export type RuntimeWindow = {
  id: number;
  focused: boolean;
  incognito: boolean;
  tabs?: RuntimeTab[];
  sessionId?: string;
};

export type OutlineNodeKind = "window" | "tab" | "group";
export type OutlineNodeStatus = "live" | "closed" | "neutral";

export type LiveRef =
  | {
      windowId: number;
      tabId?: number;
    }
  | {
      tabId: number;
      windowId: number;
    };

export type RestoreRef = {
  sessionId?: string;
  url?: string;
  title?: string;
  favIconUrl?: string;
};

export type OutlineNode = {
  id: NodeId;
  kind: OutlineNodeKind;
  status: OutlineNodeStatus;
  parentId?: NodeId;
  childIds: NodeId[];
  title: string;
  customTitle?: string;
  url?: string;
  favIconUrl?: string;
  active?: boolean;
  collapsed: boolean;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
  live?: LiveRef;
  restore?: RestoreRef;
  restoredFromClosed?: boolean;
};

export type OutlineState = {
  version: 1;
  rootIds: NodeId[];
  nodes: Record<NodeId, OutlineNode>;
};

export type Clock = {
  now: number;
};

export type CloseContext = Clock & {
  sessionId?: string;
};

export type MoveTarget = {
  parentId?: NodeId;
  index: number;
  now?: number;
};

export type LiveTabProjection = {
  tabId: number;
  windowId: number;
};

export type RestorePlan =
  | {
      kind: "session";
      nodeId: NodeId;
      sessionId: string;
      fallbackUrl?: string;
      windowNodeId?: NodeId;
    }
  | {
      kind: "url";
      nodeId: NodeId;
      url: string;
      windowNodeId?: NodeId;
    };

export type RestoredNode = {
  nodeId: NodeId;
  windowId: number;
  tabId?: number;
  active?: boolean;
  url?: string;
  title?: string;
  favIconUrl?: string;
};

export type ReconcileOptions = {
  closeMissing?: boolean;
  respectRuntimeTabOrder?: boolean;
};
