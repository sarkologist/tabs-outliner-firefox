import type {
  Clock,
  NodeId,
  OutlineNode,
  OutlineState
} from "./types.js";

export const PORTABLE_TREE_SCHEMA = "tabs-outliner-tree";
const IMPORT_GROUP_TITLE = "Group";
const CHROME_TAB_OUTLINER_IMPORT_GROUP_TITLE = "Chrome Tab Outliner import";
const CHROME_TAB_OUTLINER_NODE_RECORD_TYPE = 2001;

export type PortableTreeNode = {
  kind: "window" | "tab";
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

type ImportTree = {
  roots: PortableTreeNode[];
  importGroupTitle?: string;
};

type ChromeTabOutlinerRecord = {
  payload: Record<string, unknown>;
  path: number[];
  children: ChromeTabOutlinerRecord[];
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
  const tree = parseImportTree(payload);
  if (tree.roots.length === 0) {
    return state;
  }

  const next = copyStateForAppend(state);
  const context: AppendContext = {
    now: clock.now,
    nextIdIndex: 0,
    usedIds: new Set([...Object.keys(next.nodes), ...next.rootIds])
  };

  const importGroupId = nextPortableNodeId("window", context);
  const importGroup: OutlineNode = {
    id: importGroupId,
    kind: "window",
    status: "closed",
    childIds: [],
    title: tree.importGroupTitle ?? IMPORT_GROUP_TITLE,
    ...(tree.importGroupTitle ? { customTitle: tree.importGroupTitle } : {}),
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
  const output = new Map<NodeId, PortableTreeNode[]>();
  const expanded = new Set<NodeId>();
  const stack: Array<{ nodeId: NodeId; exiting: boolean }> = [{ nodeId: node.id, exiting: false }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const current = state.nodes[frame.nodeId];
    if (!current) {
      continue;
    }

    if (frame.exiting) {
      const children = current.childIds.flatMap((childId) => output.get(childId) ?? []);
      output.set(current.id, portableNodesFromNode(current, children));
      continue;
    }

    if (expanded.has(current.id)) {
      continue;
    }
    expanded.add(current.id);
    stack.push({ nodeId: current.id, exiting: true });
    for (let index = current.childIds.length - 1; index >= 0; index -= 1) {
      stack.push({ nodeId: current.childIds[index]!, exiting: false });
    }
  }

  return output.get(node.id) ?? [];
}

function portableNodesFromNode(node: OutlineNode, children: PortableTreeNode[]): PortableTreeNode[] {
  if (isOutlinerSidebarNode(node)) {
    return children;
  }
  if (node.kind === "window" && children.length === 0) {
    return [];
  }

  const url = node.url ?? node.restore?.url;
  const favIconUrl = node.favIconUrl ?? node.restore?.favIconUrl;
  const portable: PortableTreeNode = {
    kind: node.kind === "group" ? "window" : node.kind,
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
  const nodeId = createPortableOutlineNode(state, portable, parentId, context);
  const stack: Array<{ portable: PortableTreeNode; nodeId: NodeId; nextChildIndex: number }> = [
    { portable, nodeId, nextChildIndex: 0 }
  ];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.nextChildIndex >= frame.portable.children.length) {
      stack.pop();
      continue;
    }

    const child = frame.portable.children[frame.nextChildIndex]!;
    frame.nextChildIndex += 1;
    const childId = createPortableOutlineNode(state, child, frame.nodeId, context);
    state.nodes[frame.nodeId]?.childIds.push(childId);
    stack.push({ portable: child, nodeId: childId, nextChildIndex: 0 });
  }

  return nodeId;
}

function createPortableOutlineNode(
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

  return nodeId;
}

function normalizeImportedGroupTitle(title: string): string | undefined {
  const trimmed = title.trim();
  return trimmed ? trimmed : undefined;
}

function parseImportTree(payload: unknown): ImportTree {
  if (Array.isArray(payload)) {
    return parseChromeTabOutlinerTree(payload);
  }
  return parsePortableTree(payload);
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

function parseChromeTabOutlinerTree(payload: unknown[]): ImportTree {
  const records = payload.flatMap((entry, index) => parseChromeTabOutlinerRecord(entry, index));
  records.sort((left, right) => comparePaths(left.path, right.path));

  const recordsByPath = new Map<string, ChromeTabOutlinerRecord>();
  for (const record of records) {
    const key = chromePathKey(record.path);
    if (recordsByPath.has(key)) {
      throw invalidChromeTabOutlinerTree(`duplicate path ${formatChromePath(record.path)}`);
    }
    recordsByPath.set(key, record);
  }

  const roots: ChromeTabOutlinerRecord[] = [];
  for (const record of records) {
    const parent = nearestChromeTabOutlinerParent(recordsByPath, record.path);
    if (parent) {
      parent.children.push(record);
    } else {
      roots.push(record);
    }
  }

  return {
    roots: roots.flatMap((root) => portableNodesFromChromeTabOutlinerRecord(root)),
    importGroupTitle: CHROME_TAB_OUTLINER_IMPORT_GROUP_TITLE
  };
}

function parseChromeTabOutlinerRecord(
  entry: unknown,
  index: number
): ChromeTabOutlinerRecord[] {
  if (!Array.isArray(entry)) {
    if (isRecord(entry)) {
      return [];
    }
    throw invalidChromeTabOutlinerTree(`entry[${index}] must be an object marker or node record`);
  }

  if (entry[0] !== CHROME_TAB_OUTLINER_NODE_RECORD_TYPE) {
    throw invalidChromeTabOutlinerTree(`entry[${index}] has unsupported record type`);
  }

  return [
    {
      payload: requireChromeRecord(entry[1], `entry[${index}][1]`),
      path: parseChromePath(entry[2], `entry[${index}][2]`),
      children: []
    }
  ];
}

function parseChromePath(payload: unknown, path: string): number[] {
  if (!Array.isArray(payload)) {
    throw invalidChromeTabOutlinerTree(`${path} must be an array path`);
  }
  if (payload.length === 0) {
    throw invalidChromeTabOutlinerTree(`${path} must not be empty`);
  }

  return payload.map((part, index) => {
    if (!Number.isInteger(part) || part < 0) {
      throw invalidChromeTabOutlinerTree(`${path}[${index}] must be a non-negative integer`);
    }
    return part;
  });
}

function nearestChromeTabOutlinerParent(
  recordsByPath: Map<string, ChromeTabOutlinerRecord>,
  path: number[]
): ChromeTabOutlinerRecord | undefined {
  for (let length = path.length - 1; length > 0; length -= 1) {
    const parent = recordsByPath.get(chromePathKey(path.slice(0, length)));
    if (parent) {
      return parent;
    }
  }
  return undefined;
}

function portableNodesFromChromeTabOutlinerRecord(record: ChromeTabOutlinerRecord): PortableTreeNode[] {
  const payload = record.payload;
  const data = chromeData(payload);
  const marks = chromeMarks(payload);
  const children = record.children.flatMap((child) => portableNodesFromChromeTabOutlinerRecord(child));
  const url = optionalString(data.url);
  const favIconUrl = optionalString(data.favIconUrl);
  const title = chromeNodeTitle(payload, data, marks, url);

  if (url) {
    if (isChromeTabOutlinerPage(url, title)) {
      return children;
    }

    const node: PortableTreeNode = {
      kind: "tab",
      title,
      url,
      children
    };
    if (favIconUrl) {
      node.favIconUrl = favIconUrl;
    }
    return [node];
  }

  if (isChromeContainerRecord(payload) || children.length > 0) {
    return [
      {
        kind: "window",
        title,
        children
      }
    ];
  }

  return children;
}

function chromeNodeTitle(
  payload: Record<string, unknown>,
  data: Record<string, unknown>,
  marks: Record<string, unknown>,
  url: string | undefined
): string {
  return (
    normalizeImportedGroupTitle(optionalString(marks.customTitle) ?? "") ??
    normalizeImportedGroupTitle(optionalString(data.title) ?? "") ??
    normalizeImportedGroupTitle(optionalString(payload.title) ?? "") ??
    url ??
    IMPORT_GROUP_TITLE
  );
}

function isChromeContainerRecord(payload: Record<string, unknown>): boolean {
  return payload.type === "savedwin" || payload.type === "win" || payload.type === "group";
}

function isChromeTabOutlinerPage(url: string, title: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "chrome-extension:") {
      return false;
    }

    const normalizedTitle = title.toLocaleLowerCase();
    return (
      normalizedTitle.includes("tabs outliner") ||
      parsed.pathname.endsWith("/activesessionview.html") ||
      parsed.pathname.endsWith("/options.html")
    );
  } catch {
    return false;
  }
}

function chromeData(payload: Record<string, unknown>): Record<string, unknown> {
  if (!("data" in payload)) {
    return {};
  }
  return requireChromeRecord(payload.data, "node.data");
}

function chromeMarks(payload: Record<string, unknown>): Record<string, unknown> {
  if (!("marks" in payload)) {
    return {};
  }
  return requireChromeRecord(payload.marks, "node.marks");
}

function comparePaths(left: number[], right: number[]): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const leftPart = left[index]!;
    const rightPart = right[index]!;
    if (leftPart !== rightPart) {
      return leftPart - rightPart;
    }
  }
  return left.length - right.length;
}

function chromePathKey(path: number[]): string {
  return path.join("/");
}

function formatChromePath(path: number[]): string {
  return `[${path.join(",")}]`;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw invalidPortableTree(`${path} must be an object`);
  }
  return value;
}

function requireChromeRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw invalidChromeTabOutlinerTree(`${path} must be an object`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function invalidPortableTree(message: string): Error {
  return new Error(`Invalid portable tree: ${message}`);
}

function invalidChromeTabOutlinerTree(message: string): Error {
  return new Error(`Invalid Chrome Tab Outliner tree: ${message}`);
}

function nextPortableNodeId(kind: PortableTreeNode["kind"], context: AppendContext): NodeId {
  let nodeId: NodeId;
  do {
    context.nextIdIndex += 1;
    nodeId = `imported:${kind}:${context.now}:${context.nextIdIndex}`;
  } while (context.usedIds.has(nodeId));

  context.usedIds.add(nodeId);
  return nodeId;
}

function copyStateForAppend(state: OutlineState): OutlineState {
  return {
    version: state.version,
    rootIds: [...state.rootIds],
    nodes: { ...state.nodes }
  };
}
