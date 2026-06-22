import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sidebarHtml = readFileSync(
  new URL("../../public/sidebar/sidebar.html", import.meta.url),
  "utf8"
);
const sidebarCss = readFileSync(
  new URL("../../public/sidebar/sidebar.css", import.meta.url),
  "utf8"
);

describe("sidebar toolbar layout", () => {
  it("drops the redundant heading label to reclaim toolbar width", () => {
    // The native sidebar/window chrome already names the panel; an in-toolbar "Tabs" <h1> only
    // stole horizontal space from the search box.
    expect(sidebarHtml).not.toMatch(/<h1\b/);
    expect(sidebarCss).not.toMatch(/(^|\})\s*h1\s*\{/);
  });

  it("leads the toolbar with the search box", () => {
    const toolbar = sidebarHtml.slice(
      sidebarHtml.indexOf('<header class="toolbar">'),
      sidebarHtml.indexOf("</header>")
    );
    const searchAt = toolbar.indexOf('class="search"');
    const statusAt = toolbar.indexOf('class="status"');
    expect(searchAt).toBeGreaterThan(-1);
    expect(statusAt).toBeGreaterThan(-1);
    expect(searchAt).toBeLessThan(statusAt);
  });

  it("gives the search a usable min-width while the counter yields to ellipsis", () => {
    const toolbarRule = cssRule(".toolbar");
    expect(toolbarRule).toContain(
      "grid-template-columns: minmax(96px, 1fr) minmax(0, auto) repeat(5, auto)"
    );
    const countRule = cssRule(".count,\n.diagnostics");
    expect(countRule).toContain("text-overflow: ellipsis");
    expect(countRule).toContain("white-space: nowrap");
  });
});

function cssRule(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\n/g, "\\s*");
  const match = sidebarCss.match(new RegExp(`${escapedSelector}\\s*\\{(?<body>[^}]*)\\}`, "m"));
  expect(match?.groups?.body, `Missing CSS rule for ${selector}`).toBeDefined();
  return match!.groups!.body!;
}
