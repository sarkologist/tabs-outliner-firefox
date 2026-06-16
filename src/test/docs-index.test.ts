// Enforces the repository knowledge-base index (REPO_MAP.md) as part of `pnpm test`.
// A map that nobody checks rots; this keeps it honest. The real logic lives in
// scripts/check-docs-index.mjs so it can also run standalone (`pnpm check:docs`).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(
  new URL("../../scripts/check-docs-index.mjs", import.meta.url),
);

it("REPO_MAP.md catalogs every tracked doc and has no dangling links", () => {
  try {
    execFileSync("node", [checker], { encoding: "utf8" });
  } catch (err) {
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer };
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
    throw new Error(`docs index out of date — update REPO_MAP.md:\n\n${out}`);
  }
});
