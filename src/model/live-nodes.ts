import type { OutlineNode, OutlineState } from "./types.js";

export type LiveTabNode = OutlineNode & { live: { tabId: number; windowId: number } };
export type LiveWindowNode = OutlineNode & { live: { windowId: number } };

export function isLiveTabNode(node: OutlineNode | undefined): node is LiveTabNode {
  return Boolean(node?.kind === "tab" && node.status === "live" && node.live && "tabId" in node.live);
}

export function isLiveWindowNode(node: OutlineNode | undefined): node is LiveWindowNode {
  return Boolean(node?.kind === "window" && node.status === "live" && node.live && "windowId" in node.live);
}

export function liveTabNodes(state: OutlineState): LiveTabNode[] {
  return Object.values(state.nodes).filter(isLiveTabNode);
}

export function liveWindowNodes(state: OutlineState): LiveWindowNode[] {
  return Object.values(state.nodes).filter(isLiveWindowNode);
}
