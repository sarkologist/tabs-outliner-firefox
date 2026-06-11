import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sidebarCss = readFileSync(new URL("../../public/sidebar/sidebar.css", import.meta.url), "utf8");

describe("sidebar active row CSS", () => {
  it("uses active-row tokens with dark-mode and forced-colors fallbacks", () => {
    const activeWindowRowRule = cssRule(".node-window.is-active > .node-row");
    const activeTabRowRule = cssRule(".node-tab.is-active > .node-row");
    const activeTabTitleRule = cssRule(".node-tab.is-active > .node-row .node-title");
    const darkModeRule = mediaRule("prefers-color-scheme: dark");
    const forcedColorsRule = mediaRule("forced-colors: active");

    expect(activeWindowRowRule).toContain("border-left-color: var(--active-window-border-color)");
    expect(activeWindowRowRule).toContain("background: var(--active-window-background)");
    expect(activeTabRowRule).toContain("border-left-color: var(--active-tab-border-color)");
    expect(activeTabRowRule).toContain("background: var(--active-tab-background)");
    expect(activeTabTitleRule).toContain("color: var(--active-tab-title-color)");

    expect(darkModeRule).toContain("--active-window-background:");
    expect(darkModeRule).toContain("--active-tab-border-color:");
    expect(darkModeRule).toContain("--active-tab-background:");
    expect(darkModeRule).toContain("--active-tab-title-color:");

    expect(forcedColorsRule).toContain("background: Highlight");
    expect(forcedColorsRule).toContain("color: HighlightText");
  });
});

function cssRule(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\n/g, "\\s*");
  const match = sidebarCss.match(new RegExp(`${escapedSelector}\\s*\\{(?<body>[^}]*)\\}`, "m"));
  expect(match?.groups?.body, `Missing CSS rule for ${selector}`).toBeDefined();
  return match!.groups!.body!;
}

function mediaRule(query: string): string {
  const blockStart = sidebarCss.indexOf(`@media (${query})`);
  expect(blockStart, `Missing @media (${query}) block`).not.toBe(-1);

  const bodyStart = sidebarCss.indexOf("{", blockStart);
  expect(bodyStart, `Missing @media (${query}) body`).not.toBe(-1);

  let depth = 0;
  for (let index = bodyStart; index < sidebarCss.length; index += 1) {
    const character = sidebarCss[index];
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
    }

    if (depth === 0) {
      return sidebarCss.slice(bodyStart + 1, index);
    }
  }

  throw new Error(`Unclosed @media (${query}) block`);
}
