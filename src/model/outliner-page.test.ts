import { describe, expect, it } from "vitest";
import {
  FULL_SIZE_SIDEBAR_VIEW,
  SIDEBAR_VIEW_PARAM,
  fullSizeSidebarSearch,
  isFullSizeSidebarSearch,
  isOutlinerSidebarUrl
} from "./outliner-page.js";

describe("isFullSizeSidebarSearch", () => {
  it("recognizes the full-size sidebar popup marker", () => {
    expect(isFullSizeSidebarSearch(fullSizeSidebarSearch())).toBe(true);
    expect(isFullSizeSidebarSearch(`?${SIDEBAR_VIEW_PARAM}=${FULL_SIZE_SIDEBAR_VIEW}`)).toBe(true);
    expect(
      isFullSizeSidebarSearch(`?foo=bar&${SIDEBAR_VIEW_PARAM}=${FULL_SIZE_SIDEBAR_VIEW}`)
    ).toBe(true);
  });

  it("treats a docked sidebar (no query string) as not full-size", () => {
    // Firefox loads the docked sidebar from the manifest panel URL, which has no query string.
    expect(isFullSizeSidebarSearch("")).toBe(false);
    expect(isFullSizeSidebarSearch(undefined)).toBe(false);
    expect(isFullSizeSidebarSearch("?")).toBe(false);
  });

  it("does not match unrelated or differently-valued query strings", () => {
    expect(isFullSizeSidebarSearch("?view=docked")).toBe(false);
    expect(isFullSizeSidebarSearch("?other=window")).toBe(false);
    expect(isFullSizeSidebarSearch("?view=")).toBe(false);
  });
});

describe("fullSizeSidebarSearch", () => {
  it("appends as a query string that leaves the sidebar pathname (and its matchers) intact", () => {
    const url = `moz-extension://extension-id/sidebar/sidebar.html${fullSizeSidebarSearch()}`;
    // The marker must not perturb the pathname-based sidebar-node detection or the background's
    // `startsWith` popup probe.
    expect(isOutlinerSidebarUrl(url)).toBe(true);
    expect(url.startsWith("moz-extension://extension-id/sidebar/sidebar.html")).toBe(true);
    expect(new URL(url).pathname).toBe("/sidebar/sidebar.html");
  });
});
