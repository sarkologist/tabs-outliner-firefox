// Architectural-boundary lint (structural test).
//
// Enforces the module dependency directions that ALREADY HOLD in the codebase, turning an
// informal layering into a mechanical invariant — per the harness-engineering practice of
// "enforce boundaries centrally, allow autonomy locally". This codifies reality; it does
// not impose a boundary that would require refactoring (see the not-yet-enforced note).
//
// Layering (top-level dirs under src/):
//   model      — the pure domain core (outline, portable tree). Depends on NOTHING else.
//   background — owns the outline + runtime reconciliation/persistence. May use model/perf.
//   sidebar    — the UI projection client. May use model/perf (and, for now, background).
//   options    — the options page (a separate UI entry point).
//   viewer     — the read-only exported-tree viewer page (a leaf UI surface). Uses only model;
//                talks to the background solely via runtime messages, never direct imports.
//   perf       — cross-cutting instrumentation. May reach into background/model by design.
//
// NOT YET ENFORCED (tracked, intentionally allowed today): `sidebar -> background` (~11
// edges). REMOTE_PROJECTION_REWRITE.md is moving the sidebar toward a pure projection
// client that talks to the background only via messages; once those imports are gone, add
// `{ from: "sidebar", to: ["background"] }` below to lock the direction in.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("..", import.meta.url)); // .../src

// Forbidden edges. Each is currently clean (zero violations); the test locks that in.
const FORBIDDEN: { from: string; to: string[]; why: string }[] = [
  {
    from: "model",
    to: ["background", "sidebar", "options", "viewer", "perf", "(root)"],
    why: "model/ is the pure domain core; it must not import other layers."
  },
  {
    from: "background",
    to: ["sidebar", "options", "viewer"],
    why: "background/ owns the outline; it must not depend on the UI (sidebar/options/viewer)."
  },
  {
    from: "perf",
    to: ["sidebar", "options", "viewer"],
    why: "perf/ instrumentation must not depend on the UI layers."
  },
  {
    from: "sidebar",
    to: ["options", "viewer"],
    why: "the sidebar must not depend on the options page or the viewer page."
  },
  {
    from: "viewer",
    to: ["background", "sidebar", "options"],
    why: "the viewer is a leaf UI surface; it uses only model/ and talks to the background via messages."
  }
];

const topDir = (relPosix: string): string => {
  const i = relPosix.indexOf("/");
  return i === -1 ? "(root)" : relPosix.slice(0, i);
};

function productionFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
        continue;
      }
      if (!ent.name.endsWith(".ts")) continue;
      if (/\.test\.ts$/.test(ent.name) || /\.test-support\.ts$/.test(ent.name)) continue;
      const rel = path.relative(SRC, full).split(path.sep).join("/");
      if (rel.startsWith("test/")) continue; // src/test/* is test scaffolding
      out.push(full);
    }
  };
  walk(SRC);
  return out;
}

function relativeImportSpecifiers(text: string): string[] {
  const specs: string[] = [];
  for (const m of text.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
    if (m[1] !== undefined) specs.push(m[1]);
  }
  for (const m of text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) {
    if (m[1] !== undefined) specs.push(m[1]);
  }
  return specs.filter((s) => s.startsWith("."));
}

const forbiddenFor = (from: string) => FORBIDDEN.filter((r) => r.from === from);

it("production modules respect the layer dependency boundaries", () => {
  const violations: string[] = [];
  for (const file of productionFiles()) {
    const rel = path.relative(SRC, file).split(path.sep).join("/");
    const from = topDir(rel);
    const rules = forbiddenFor(from);
    if (rules.length === 0) continue;
    const fromDirPosix = path.posix.dirname(rel);
    for (const spec of relativeImportSpecifiers(readFileSync(file, "utf8"))) {
      const target = path.posix.normalize(path.posix.join(fromDirPosix, spec));
      const to = topDir(target);
      for (const rule of rules) {
        if (rule.to.includes(to)) {
          violations.push(`  ${rel}\n      imports "${spec}" (-> ${to}/)\n      ✗ ${rule.why}`);
        }
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `Module boundary violation(s) — see the layering note in this test file:\n\n` +
        violations.join("\n\n") +
        `\n\nFix: depend "forward" through the layers (e.g. share types via model/), or, if ` +
        `a layer genuinely needs to widen, update FORBIDDEN here with the rationale.`
    );
  }
});
