# Sidebar Startup Storage Fanout Autoresearch

This loop targets the gap where synthetic startup profiles are fast but exported real-browser profiles still show slow full hydration. The 2026-05-26 real profile showed the bottleneck in Firefox `storage.local` fanout:

- `background.state.load.v3.nodeShardRead`: about 2,000ms for 256 keys.
- `background.state.load.v3.orderPageRead`: about 680ms for 7,062 keys.
- `background.state.save`: multi-second saves after startup events.
- Sidebar first paint is already fast; the slow user-visible phase is full hydration/getState after the sparse initial snapshot.

## Setup

1. Use a feature branch, for example:
   `git switch -c codex/autoresearch-sidebar-startup-storage-<tag>`
2. Build before each measured browser export:
   `pnpm run build`
3. Keep local evidence untracked:
   `autoresearch/sidebar-startup-storage-fanout/*.tsv`
   `autoresearch/sidebar-startup-storage-fanout/*.log`

## Baselines

Run the synthetic real-browser mimic to keep CPU and coordination comparable:

`pnpm profile:sidebar-startup -- --shape real-browser-20260526 --runs 5 --tag <tag> --description "synthetic real-browser baseline" --results autoresearch/sidebar-startup-storage-fanout/synthetic.tsv --append-results`

Then capture a real browser profile from the options page after reproducing startup with multiple sidebars open. Analyze the exported JSON:

`pnpm analyze:profile-export -- <profile-export.json> --tag <tag> --description "real browser baseline" --append-results`

The analyzer appends to:

`autoresearch/sidebar-startup-storage-fanout/profile-export-results.tsv`

## Primary Metrics

The real-profile primary metric is `primary_ms` from `pnpm analyze:profile-export`. It is the maximum of:

- sidebar `hydration` max.
- sidebar `getState` command max.
- background `getState` runtime message max.
- background `getTreeProjectionSlice` runtime message max.
- background `state.load` max.

Storage diagnosis metrics:

- `background_state_load_max_ms`
- `node_shard_read_max_ms`
- `node_shard_read_keys`
- `order_page_read_max_ms`
- `order_page_read_keys`
- `save_max_ms`
- `save_count`

Synthetic guard metrics:

- `real_mimic_median_ms`
- `real_mimic_get_state_median_ms`
- `real_mimic_projection_slice_ms`
- `real_mimic_save_flush_ms`
- `snapshot_rows` and `snapshot_nodes`
- broadcasts and runtime event counts

## Candidate Order

1. Reduce future node shard read fanout.
   - Current real profile reads 256 node shard keys.
   - Try fewer/larger shards first: 32, 16, then 8.
   - This may change the storage format. Announce that explicitly before implementation.

2. Reduce order-page read fanout.
   - Current real profile reads about 7,062 order page keys.
   - Try inline child order for small parents, section-packed order pages, or a compact order index.
   - This may change the storage format.

3. Reduce startup save fanout.
   - Track `background.state.save` max and save key counts.
   - Prefer fewer/larger writes or delayed compaction if correctness allows.

4. Only after storage fanout is smaller, revisit CPU phases like materialization or projection.

## Storage Compatibility

Backward compatibility with old local storage is not required for this loop unless the user asks for it. If a candidate changes the storage format, say so before editing and make the tests assert the new format directly. Keep extension message types, sidebar transport, and first-paint snapshot limits unchanged.

## Experiment Loop

For each candidate:

1. Pick the largest real-profile storage cost with a bounded implementation idea.
2. Add or update a failing storage/perf test first.
3. Make the smallest implementation change.
4. Run:
   `pnpm test -- src/background/storage-v2.test.ts src/perf/runtime-guard.test.ts`
   `pnpm run build`
   `pnpm profile:sidebar-startup -- --shape real-browser-20260526 --runs 3 --tag <tag> --baseline-ms <current-synthetic-primary> --description "<short idea>" --results autoresearch/sidebar-startup-storage-fanout/synthetic.tsv --append-results`
   `pnpm exec playwright test tests/playwright/sidebar-first-paint.spec.ts --reporter=list`
5. Capture and analyze a real browser export when the synthetic result is promising:
   `pnpm analyze:profile-export -- <profile-export.json> --tag <tag> --description "<short idea>" --append-results`
6. Keep only if both synthetic and real-profile metrics improve and no hard guard regresses.
7. Commit kept candidates with synthetic and real-profile before/after metrics in the message.
8. Revert only experiment code for discarded candidates and leave TSV rows as local evidence.

## Acceptance

Keep a candidate when:

- Real `primary_ms` improves by at least `min(10%, 50ms)` versus current best.
- `node_shard_read_max_ms`, `order_page_read_max_ms`, or `save_max_ms` improves if that was the targeted cost.
- Synthetic `real-browser-20260526` does not regress beyond noise.
- First-paint snapshot rows/nodes stay `<= 256`.
- Broadcasts stay `0` in synthetic startup.
- Playwright first-paint and projection guard pass.

Stop when:

- Two consecutive bounded candidates are discarded.
- No remaining real-profile storage phase above 25ms has a low-risk hypothesis.
- The next plausible improvement requires a product/storage reset decision that has not been confirmed.
