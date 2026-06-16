// Doc freshness gate: load-bearing docs must not cite files that no longer exist.
// (This caught I-2's stale `storage-v2.test.ts` citation — the file was renamed to
// storage-legacy.test.ts.) Semantic freshness — stale prose, historical line numbers, dead
// scripts — needs human judgment and is the gardener's job, not a brittle deterministic
// check (see docs/repo-gardening.md).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function repoFileNames(): Set<string> {
  const names = new Set<string>();
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name === "dist" || ent.name === ".git") continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else names.add(ent.name);
    }
  };
  walk(ROOT);
  return names;
}

it("INVARIANTS.md cites only source/test files that still exist", () => {
  const text = readFileSync(path.join(ROOT, "INVARIANTS.md"), "utf8");
  const refs = [...text.matchAll(/`([\w./-]+\.(?:ts|mjs|json))`/g)]
    .map((m) => m[1])
    .filter((s): s is string => s !== undefined);
  const present = repoFileNames();
  const missing = [...new Set(refs)].filter((r) => !present.has(r.split("/").pop() ?? r));
  expect(
    missing,
    `INVARIANTS.md cites file(s) that no longer exist (probably renamed): ${missing.join(", ")}. ` +
      'Update the "Enforced by:" citation to the current file.',
  ).toEqual([]);
});
