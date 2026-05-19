import type { OutlineNode } from "./types.js";

export function isOutlinerSidebarNode(node: Pick<OutlineNode, "url" | "restore">): boolean {
  return isOutlinerSidebarUrl(node.url ?? node.restore?.url);
}

export function isOutlinerSidebarUrl(url: string | undefined): boolean {
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
