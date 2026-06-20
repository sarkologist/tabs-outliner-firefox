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

// The full-size sidebar is the same `sidebar/sidebar.html` page opened by the background in its own
// popup window (the toolbar "Open full-size sidebar" button). The background marks that popup URL
// with this query string so the page can tell itself apart from a docked, per-window sidebar -- which
// Firefox loads from the manifest `sidebar_action` panel URL, with no query string. A docked sidebar
// follows its own window's active tab; a detached full-size view must not chase whichever window
// currently has focus. The marker rides the query string, not the pathname, so every sidebar-URL
// matcher above (and the background's `startsWith` popup probe) keeps working unchanged.
export const SIDEBAR_VIEW_PARAM = "view";
export const FULL_SIZE_SIDEBAR_VIEW = "window";

export function fullSizeSidebarSearch(): string {
  return `?${SIDEBAR_VIEW_PARAM}=${FULL_SIZE_SIDEBAR_VIEW}`;
}

export function isFullSizeSidebarSearch(search: string | undefined): boolean {
  if (!search) {
    return false;
  }
  try {
    return new URLSearchParams(search).get(SIDEBAR_VIEW_PARAM) === FULL_SIZE_SIDEBAR_VIEW;
  } catch {
    return false;
  }
}
