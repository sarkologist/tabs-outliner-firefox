#!/usr/bin/env node
// Mechanical freshness check for the repository knowledge-base index (REPO_MAP.md).
//
// Fails when:
//   1. a tracked *.md file is not catalogued (linked) in REPO_MAP.md, or
//   2. REPO_MAP.md / AGENTS.md / CLAUDE.md link to a markdown file that is not tracked
//      in git (a dangling or untracked-only link).
//
// Keying off `git ls-files` (tracked files only) keeps the check CI- and clone-safe and
// ignores untracked debris (profile dumps, scratch guides). Error messages are written to
// be directly actionable, per the harness-engineering practice of injecting remediation
// into agent context rather than emitting bare "violation detected".

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8"
}).trim();

const INDEX = "REPO_MAP.md";
// Entry-point files whose markdown links must resolve to tracked files.
const LINK_SOURCES = [INDEX, "AGENTS.md", "CLAUDE.md"];

const read = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");

// All tracked markdown files (includes anything currently staged).
const trackedMd = execFileSync("git", ["ls-files", "*.md"], {
  encoding: "utf8",
  cwd: repoRoot
})
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean);
const trackedSet = new Set(trackedMd);

// Markdown link targets (-> *.md) found in a file, normalized to repo-root-relative paths.
function mdLinkTargets(rel) {
  const targets = new Set();
  const re = /\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(read(rel))) !== null) {
    let t = m[1].split("#")[0].trim(); // drop #anchors
    if (!t || !t.toLowerCase().endsWith(".md")) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) continue; // skip external URLs
    if (t.startsWith("./")) t = t.slice(2);
    targets.add(t);
  }
  return targets;
}

const errors = [];

// Check 1: every tracked .md (except the index itself) is catalogued in REPO_MAP.md.
const indexed = mdLinkTargets(INDEX);
const missing = trackedMd.filter((f) => f !== INDEX && !indexed.has(f));
if (missing.length) {
  errors.push(
    `${missing.length} tracked doc(s) are not catalogued in ${INDEX}:\n` +
      missing.map((f) => `  - ${f}`).join("\n") +
      `\n  Fix: add a one-line "[<name>](<path>)" entry under the right section of ${INDEX}.`
  );
}

// Check 2: every .md link in the entry points resolves to a tracked file.
for (const src of LINK_SOURCES) {
  const dangling = [...mdLinkTargets(src)].filter((t) => !trackedSet.has(t));
  if (dangling.length) {
    errors.push(
      `${src} links to markdown file(s) not tracked in git:\n` +
        dangling.map((t) => `  - ${t}`).join("\n") +
        `\n  Fix: correct the path, or 'git add' the file if it belongs in the repo.`
    );
  }
}

if (errors.length) {
  console.log(`✗ docs index check failed (${INDEX}):\n\n${errors.join("\n\n")}`);
  process.exit(1);
}

console.log(
  `✓ docs index OK: ${trackedMd.length} tracked markdown files, all catalogued in ` +
    `${INDEX}; all ${LINK_SOURCES.join("/")} markdown links resolve.`
);
