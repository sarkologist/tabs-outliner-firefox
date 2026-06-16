// Debt ratchets — each tracked debt metric may only move DOWN. The solo-scaled
// "garbage collection" gate (see docs/repo-gardening.md, docs/QUALITY.md): drift cannot be
// ADDED silently. Lower a baseline in debt-baseline.json when you pay debt down; raising it
// is a deliberate, reviewed acknowledgment.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

interface Baseline {
  sidebarToBackgroundEdges: number;
  todoComments: number;
  largeFileThresholdLines: number;
  allowedLargeFiles: string[];
}
const baseline = JSON.parse(
  readFileSync(path.join(ROOT, "debt-baseline.json"), "utf8"),
) as Baseline;

const topDir = (rel: string): string => {
  const i = rel.indexOf("/");
  return i === -1 ? "(root)" : rel.slice(0, i);
};

function productionFiles(): { full: string; rel: string }[] {
  const out: { full: string; rel: string }[] = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
        continue;
      }
      if (!ent.name.endsWith(".ts")) continue;
      if (/\.test\.ts$/.test(ent.name) || /\.test-support\.ts$/.test(ent.name)) continue;
      const rel = path.relative(SRC, full).split(path.sep).join("/");
      if (rel.startsWith("test/")) continue;
      out.push({ full, rel });
    }
  };
  walk(SRC);
  return out;
}

const lineCount = (full: string): number => {
  const c = readFileSync(full, "utf8");
  if (c === "") return 0;
  return c.split("\n").length - (c.endsWith("\n") ? 1 : 0);
};

const files = productionFiles();

let sidebarToBackground = 0;
for (const { full, rel } of files) {
  if (topDir(rel) !== "sidebar") continue;
  for (const m of readFileSync(full, "utf8").matchAll(
    /(?:from|import)\s*\(?\s*["']([^"']+)["']/g,
  )) {
    const spec = m[1];
    if (spec === undefined || !spec.startsWith(".")) continue;
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
    if (topDir(target) === "background") sidebarToBackground++;
  }
}

let todos = 0;
for (const { full } of files) {
  todos += [...readFileSync(full, "utf8").matchAll(/\b(?:TODO|FIXME|XXX|HACK)\b/g)].length;
}

const newLargeFiles = files
  .filter(({ full }) => lineCount(full) > baseline.largeFileThresholdLines)
  .map(({ rel }) => rel)
  .filter((rel) => !baseline.allowedLargeFiles.includes(rel));

it("sidebar→background imports do not increase (target 0)", () => {
  expect(
    sidebarToBackground,
    "sidebar→background imports rose above the baseline; this may only go DOWN. Remove an " +
      "import (the sidebar is migrating to a pure projection client, see " +
      "REMOTE_PROJECTION_REWRITE.md), or — only if truly intended — lower it in debt-baseline.json.",
  ).toBeLessThanOrEqual(baseline.sidebarToBackgroundEdges);
});

it("no TODO/FIXME/XXX/HACK markers are added to production code", () => {
  expect(
    todos,
    "production debt markers rose above the baseline. Resolve the issue instead of leaving " +
      "a marker, or capture it in docs/PROJECT_STATE.md.",
  ).toBeLessThanOrEqual(baseline.todoComments);
});

it("no new production file crosses the large-file threshold", () => {
  expect(
    newLargeFiles,
    `new production file(s) exceed ${baseline.largeFileThresholdLines} lines: ` +
      `${newLargeFiles.join(", ")}. Keep new modules small, or deliberately add the path to ` +
      "allowedLargeFiles in debt-baseline.json.",
  ).toEqual([]);
});
