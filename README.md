# Tab Session Outliner

A Firefox sidebar extension for keeping a durable outline of live and recently closed tabs.

## Features

- Shows windows and tabs as a nested sidebar outline.
- Tracks live tabs and keeps recently closed tabs/windows available in the outline.
- Focuses live tabs from the sidebar and restores closed tabs or groups.
- Closes, deletes, collapses, expands, flattens, renames, and drag-reorders outline nodes.
- Searches the outline, including matches inside collapsed groups.
- Exports the outline to JSON and imports saved outlines, including Chrome Tab Outliner-style exports.
- Persists outline state locally with Firefox extension storage.
- Includes sidebar zoom controls and lightweight diagnostics for checking browser/outline state.

## Install as a Temporary Add-on

Temporary add-ons are useful for local development. Firefox removes them when the browser restarts, so repeat the load step after a restart.

Requirements:

- Firefox 127 or newer
- Node.js with Corepack/pnpm available

Build the extension:

```sh
corepack enable
pnpm install
pnpm run build
```

Load it in Firefox:

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...**.
3. Select `dist/manifest.json` from this repository.
4. Open the **Tab Session Outliner** sidebar if it does not open automatically.

After code changes, run `pnpm run build` again, then use **Reload** for the temporary add-on in `about:debugging`.

## Development

```sh
pnpm run test
pnpm run build
pnpm run check
```

The build compiles TypeScript into `dist/` and copies the static extension files from `public/`.
