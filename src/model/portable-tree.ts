import type {
  Clock,
  NodeId,
  OutlineNode,
  OutlineNodeKind,
  OutlineState
} from "./types.js";

export const PORTABLE_TREE_SCHEMA = "tabs-outliner-tree";
const IMPORT_GROUP_TITLE = "Group";

export type PortableTreeNode = {
  kind: OutlineNodeKind;
  title: string;
  url?: string;
  favIconUrl?: string;
  children: PortableTreeNode[];
};

export type PortableTreeFile = {
  schema: typeof PORTABLE_TREE_SCHEMA;
  version: 1;
  exportedAt: string;
  roots: PortableTreeNode[];
};

type AppendContext = Clock & {
  nextIdIndex: number;
  usedIds: Set<NodeId>;
};

export function exportPortableTree(
  state: OutlineState,
  clock: Clock = { now: Date.now() }
): PortableTreeFile {
  return {
    schema: PORTABLE_TREE_SCHEMA,
    version: 1,
    exportedAt: new Date(clock.now).toISOString(),
    roots: state.rootIds.flatMap((rootId) => {
      const root = state.nodes[rootId];
      return root ? portableNodesFromOutline(state, root) : [];
    })
  };
}

export function appendPortableTree(
  state: OutlineState,
  payload: unknown,
  clock: Clock
): OutlineState {
  const tree = parsePortableTree(payload);
  const next = cloneState(state);
  const context: AppendContext = {
    now: clock.now,
    nextIdIndex: 0,
    usedIds: new Set([...Object.keys(next.nodes), ...next.rootIds])
  };

  if (tree.roots.length === 0) {
    return next;
  }

  const importGroupId = nextPortableNodeId("window", context);
  const importGroup: OutlineNode = {
    id: importGroupId,
    kind: "window",
    status: "closed",
    childIds: [],
    title: IMPORT_GROUP_TITLE,
    collapsed: false,
    createdAt: clock.now,
    updatedAt: clock.now,
    closedAt: clock.now
  };
  next.nodes[importGroupId] = importGroup;
  next.rootIds.push(importGroupId);

  for (const root of tree.roots) {
    importGroup.childIds.push(appendPortableNode(next, root, importGroupId, context));
  }

  return next;
}

function portableNodesFromOutline(state: OutlineState, node: OutlineNode): PortableTreeNode[] {
  const children = node.childIds.flatMap((childId) => {
    const child = state.nodes[childId];
    return child ? portableNodesFromOutline(state, child) : [];
  });
  if (isOutlinerSidebarNode(node)) {
    return children;
  }
  if (node.kind === "window" && children.length === 0) {
    return [];
  }

  const url = node.url ?? node.restore?.url;
  const favIconUrl = node.favIconUrl ?? node.restore?.favIconUrl;
  const portable: PortableTreeNode = {
    kind: node.kind,
    title: node.title || node.restore?.title || "Untitled",
    children
  };

  if (url) {
    portable.url = url;
  }
  if (favIconUrl) {
    portable.favIconUrl = favIconUrl;
  }

  return [portable];
}

function isOutlinerSidebarNode(node: OutlineNode): boolean {
  const url = node.url ?? node.restore?.url;
  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol === "moz-extension:" && parsed.pathname === "/sidebar/sidebar.html") {
      return true;
    }
    return parsed.protocol === "file:" && parsed.pathname.endsWith("/public/sidebar/sidebar.html");
  } catch {
    return false;
  }
}

function appendPortableNode(
  state: OutlineState,
  portable: PortableTreeNode,
  parentId: NodeId | undefined,
  context: AppendContext
): NodeId {
  const nodeId = nextPortableNodeId(portable.kind, context);
  const importedGroupTitle = portable.kind === "window" ? normalizeImportedGroupTitle(portable.title) : undefined;
  const node: OutlineNode = {
    id: nodeId,
    kind: portable.kind,
    status: "closed",
    ...(parentId ? { parentId } : {}),
    childIds: [],
    title: portable.kind === "window" ? importedGroupTitle ?? IMPORT_GROUP_TITLE : portable.title,
    ...(importedGroupTitle ? { customTitle: importedGroupTitle } : {}),
    ...(portable.url ? { url: portable.url } : {}),
    ...(portable.favIconUrl ? { favIconUrl: portable.favIconUrl } : {}),
    collapsed: false,
    createdAt: context.now,
    updatedAt: context.now,
    closedAt: context.now,
    ...(portable.kind === "tab" && portable.url
      ? {
          restore: {
            url: portable.url,
            title: portable.title,
            ...(portable.favIconUrl ? { favIconUrl: portable.favIconUrl } : {})
          }
        }
      : {})
  };
  state.nodes[nodeId] = node;

  for (const child of portable.children) {
    node.childIds.push(appendPortableNode(state, child, nodeId, context));
  }

  return nodeId;
}

function normalizeImportedGroupTitle(title: string): string | undefined {
  const trimmed = title.trim();
  return trimmed ? trimmed : undefined;
}

function parsePortableTree(payload: unknown): PortableTreeFile {
  const value = requireRecord(payload, "root");
  if (value.schema !== PORTABLE_TREE_SCHEMA) {
    throw invalidPortableTree("schema must be tabs-outliner-tree");
  }
  if (value.version !== 1) {
    throw invalidPortableTree("version must be 1");
  }
  if (typeof value.exportedAt !== "string") {
    throw invalidPortableTree("exportedAt must be a string");
  }
  if (!Array.isArray(value.roots)) {
    throw invalidPortableTree("roots must be an array");
  }

  return {
    schema: PORTABLE_TREE_SCHEMA,
    version: 1,
    exportedAt: value.exportedAt,
    roots: value.roots.map((node, index) => parsePortableNode(node, `roots[${index}]`))
  };
}

function parsePortableNode(payload: unknown, path: string): PortableTreeNode {
  const value = requireRecord(payload, path);
  if (value.kind !== "window" && value.kind !== "tab") {
    throw invalidPortableTree(`${path}.kind must be window or tab`);
  }
  if (typeof value.title !== "string") {
    throw invalidPortableTree(`${path}.title must be a string`);
  }
  if (!Array.isArray(value.children)) {
    throw invalidPortableTree(`${path}.children must be an array`);
  }

  const node: PortableTreeNode = {
    kind: value.kind,
    title: value.title,
    children: value.children.map((child, index) => parsePortableNode(child, `${path}.children[${index}]`))
  };

  if ("url" in value) {
    if (typeof value.url !== "string") {
      throw invalidPortableTree(`${path}.url must be a string`);
    }
    node.url = value.url;
  }

  if ("favIconUrl" in value) {
    if (typeof value.favIconUrl !== "string") {
      throw invalidPortableTree(`${path}.favIconUrl must be a string`);
    }
    node.favIconUrl = value.favIconUrl;
  }

  return node;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidPortableTree(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function invalidPortableTree(message: string): Error {
  return new Error(`Invalid portable tree: ${message}`);
}

function nextPortableNodeId(kind: OutlineNodeKind, context: AppendContext): NodeId {
  let nodeId: NodeId;
  do {
    context.nextIdIndex += 1;
    nodeId = `imported:${kind}:${context.now}:${context.nextIdIndex}`;
  } while (context.usedIds.has(nodeId));

  context.usedIds.add(nodeId);
  return nodeId;
}

function cloneState(state: OutlineState): OutlineState {
  const nodes: Record<NodeId, OutlineNode> = {};
  for (const [id, node] of Object.entries(state.nodes)) {
    const cloned: OutlineNode = {
      ...node,
      childIds: [...node.childIds]
    };
    if (node.live) {
      cloned.live = { ...node.live };
    } else {
      delete cloned.live;
    }
    if (node.restore) {
      cloned.restore = { ...node.restore };
    } else {
      delete cloned.restore;
    }
    nodes[id] = cloned;
  }

  return {
    version: state.version,
    rootIds: [...state.rootIds],
    nodes
  };
}
