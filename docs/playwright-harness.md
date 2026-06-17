# Playwright sidebar-runtime harness

`Status: reference` — how to write a browser test against the real UI. The harness is
[`tests/playwright/support/sidebar-runtime-harness.ts`](../tests/playwright/support/sidebar-runtime-harness.ts);
[`sidebar-runtime-integration.spec.ts`](../tests/playwright/sidebar-runtime-integration.spec.ts)
is the worked example. AGENTS.md requires browser UI behavior to be covered by Playwright
tests that drive the real built UI with deterministic fixtures — this is the harness that
makes that deterministic.

## What it actually wires up (the load-bearing contract)

`createSidebarRuntimeHarness({ windows, tabs, initialStorage?, now? })` builds:

- **The REAL background controller, in-process.** It calls `createBackgroundController(...)`
  (the same factory production uses) against a **fake** WebExtension runtime
  (`createFakeWebExtensionRuntime`). The test exercises genuine reconciliation, persistence,
  history, and broadcast logic — not a stub. `windows`/`tabs` seed the fake browser;
  `initialStorage` seeds `storage.local`; `now` makes time deterministic.
- **A page-side `window.browser` mock that exposes only a SUBSET of the API.** `attachPage`
  injects (via `addInitScript`) a `window.browser` with **only**:
  - `runtime.sendMessage`, `runtime.getURL`, `runtime.openOptionsPage`, `runtime.onMessage`
  - `storage.local.{get,set,remove}`, `storage.onChanged`

  That's it. There is **no `browser.windows`, no `browser.tabs`, no `browser.windows.create`**
  on the page. A UI path that calls `browser.windows.create` directly will throw in a test.
  (The controller-request commands like `openSidebarWindow` call `windows.create` on the
  *background* side — the fake `runtime.api`, which does have it — so they work; a *page* that
  reaches for `windows.*` itself does not.)
- **The bridge.** Page → background is `window.browser.runtime.sendMessage` →
  `runtime.sendMessageFromPage`. Background → page broadcasts and `storage.onChanged` events
  are pushed into the page and re-dispatched to the listeners the sidebar registered, so the
  real patch/echo path runs end to end.

## `load()` is hardcoded to the sidebar

```ts
async load() { await page.goto("/sidebar/sidebar.html"); await waitForIdle(); }
```

So `attachedPage.load()` only ever opens the sidebar. **To test any other page** (options
page, the exported-tree viewer, a popup) you still call `attachPage(page)` to get the
`window.browser` bridge, but then `page.goto("/your/path.html")` yourself instead of `load()`.

## Minimal usage

```ts
const harness = createSidebarRuntimeHarness({ windows, tabs, now: () => NOW });
const sidebar = await harness.attachPage(page);
await sidebar.load();                 // opens /sidebar/sidebar.html, then waits for idle

await harness.runtime.createTabFromBrowser(tab(2, 1, 1, false, "Beta"));
await harness.waitForIdle();          // pump fake runtime + page macrotasks deterministically

// Assert BOTH visible behavior AND runtime/persisted state (per AGENTS.md):
await expect(page.getByRole("treeitem", { name: "Beta" })).toBeVisible();
await harness.assertCleanBackground(); // runtime-model invariants + no missing runtime tabs
expect(sidebar.issues).toEqual([]);    // no console errors / pageerror / requestfailed
```

## The assertion surface

- `harness.waitForIdle()` — settle async work without timing-only waits (it pumps the fake
  runtime and page macrotasks across several passes). Prefer this over `waitForTimeout`.
- `harness.state()` / `harness.diagnostics()` — read the real background outline state and
  diagnostics for invariant assertions.
- `harness.assertCleanBackground()` — asserts runtime-model invariants hold and no runtime
  tabs are missing; the cheap default "nothing is broken" check.
- `attachedPage.issues` — collected console errors, page errors, and failed requests; assert
  `toEqual([])`.
- `attachedPage.protocol()` / `attachedPage.sideEffects()` — inspect the recorded message
  protocol and fake-runtime side effects (e.g. assert a compact patch was sent, not a full
  `getState`). `clearProtocol()` resets them.
- `attachedPage.profileSummary()` — the in-page `tabsOutlinerProfile` summary, for
  perf-trace assertions.

Run the suite with `pnpm exec playwright test` (or `pnpm test:playwright`).
