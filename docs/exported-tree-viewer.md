# Exported-tree viewer

Status: shipped (feature).

A separate, read-only surface for inspecting a previously **exported** tree and selectively
pulling pieces of it into the live outline. It reuses the existing portable-tree export format
as input — no new format.

## What it is

- A standalone extension page, [public/viewer/viewer.html](../public/viewer/viewer.html) +
  [src/viewer/viewer.ts](../src/viewer/viewer.ts), opened in its own popup window (distinct
  from the main sidebar).
- Opened from the **options page** ("Exported tree viewer" → "Open exported-tree viewer"),
  which sends an `openImportViewerWindow` controller request; the background opens the popup
  via `windows.create` (mirrors `openSidebarWindow`). Because the window is `type: "popup"`,
  `getNormalWindows` filters it, so it never enters the outline or drives reconciliation.
- The user loads an exported `tabs-outliner-tree-*.json` file (portable format, or a legacy
  Chrome Tab Outliner export — both handled by the model parser) and sees it rendered as a
  nested, navigable outline.

## Read-only contract

The viewed tree is **strictly read-only**: no rename/move/delete/close/restore/drag. The only
per-node actions are:

1. **Expand / collapse** a subtree (children render lazily on first expand).
2. **Import** — append that node together with its entire subtree to the current live outline
   as new **top-level** node(s).

## Import semantics

- The exported view is **never** mutated by an import.
- Importing the same node more than once is allowed; each import creates **independent** new
  nodes with fresh ids appended at the top level — **no merge, no dedupe**.
- Unlike whole-file import (`importTree`, which wraps everything under one synthetic "Group"
  node), the selected node itself becomes a new top-level root.

## Where the behavior lives

- Model: `appendPortableSubtreesAtTopLevel` + `parsePortableImport` in
  [src/model/portable-tree.ts](../src/model/portable-tree.ts) (pure; unit-tested in
  `portable-tree.test.ts`).
- Command: `importSubtreeToTopLevel` in
  [src/background/commands.ts](../src/background/commands.ts), routed by the controller exactly
  like `importTree` (structural, history-trackable "Import", broad/no-candidate patch).
- The viewer imports only from `model/` and talks to the background solely via runtime messages
  (I-16 leaf-UI boundary, enforced by `src/test/architecture-boundaries.test.ts`).

## Tests

- Unit: model + command append-to-top-level (`portable-tree.test.ts`, `commands.test.ts`).
- Browser: read-only render, expand/collapse, import-to-top-level end-to-end, repeated-import
  independence, and the background popup open
  ([tests/playwright/viewer-import.spec.ts](../tests/playwright/viewer-import.spec.ts)); the
  options entry point in `tests/playwright/options-page.spec.ts`.
