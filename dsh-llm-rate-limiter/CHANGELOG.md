# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.3.0] - 2026-09-28

**Requires DSH 0.1.7-rc.1 or newer.** For DSH 0.1.5-rc.3, stay on `0.2.x`.

### Changed (breaking)

DSH 0.1.7 replaced both client services this plugin used for its settings UI, and
removed the host namespace API. All four breakpoints are source-verified against
the installed 0.1.7-rc.1 tree:

- **Client: `settingsScope` → `configForms`.** `SettingsScopeController` is gone;
  the page now hands each `plugins.item` entry a `ConfigForm` as
  `props.form` (`dsh-client-ui-plugin-manager/lib/client.js:2627-2634`, `:2832`).
  The snapshot shape is unchanged (`{status, value, base, user, revision, writable,
  mode}`), so the card reads `props.form.state.value` exactly as it read
  `settingsScope.getSnapshot().value`.
- **Client slot: `settings.plugin.item` → `plugins.item`**, declared by
  `dsh-client-ui-plugin-manager` (`slot-contract.d.ts:90`). The page draws the
  card chrome itself and asks the entry for `view: "summary"` and
  `view: "page"`; the plugin renders the one-liner and the body respectively.
  `id` replaces `key` (a list slot requires `id`, `dsh-client-ui-slots/lib/index.js:182`),
  and `order: 900` parks the card after the official pages (10/20/30/40).
- **Client inject: `["slots", "locale", "configForms"]`**, and the plugin now
  registers its own locale dictionary — an entry that `declares locale namespace`
  with no dictionary installed throws `SlotAssemblyError`
  (`dsh-client-ui-renderer/lib/client.js:723`). Previously the plugin declared
  `locale: name` without ever registering it.
- **Host: `ctx.settings.register()` / `scope.watch()` removed.** Configuration is
  now the profile entry's own `Config`, which the plugin exports
  (`export { apply, name, SETTINGS_NS, Config }`) and reads through volatile
  references. Every editable leaf is marked `.volatile()`.

### Fixed

- **The plugin no longer hangs in `pending` on DSH 0.1.7.** It previously waited
  for a `settingsScope` service the framework no longer provides.

### Changed

- **`models` is volatile as ONE BLOCK** — `z.dict(ModelOverride).volatile()`,
  never `z.dict(ModelOverride.volatile())`. The latter is rejected by
  schemastery ("volatile fields require a fixed object path without an enclosing
  volatile field", `schemastery/lib/index.mjs:246`). Because
  `isVolatilePath` returns true on reaching ANY volatile node without inspecting
  its descendants (`dsh-settings/lib/index.js:153-158`), nested writes such as
  `["models", "provider/model", "maxRpm"]` still work — the plugin's per-model
  editor is unaffected.
- Configuration is now read **at each use** (`config.enabled.get()`) rather than
  cached. A volatile-only settings write updates the references in place via the
  loader's `_commitVolatile()` (`cordis-plugin-loader/lib/index.js:393`)
  **without re-running `apply()`**, so a cached snapshot would go stale.
- The plugin opts out of schema-generated pages with
  `settings.configure({ auto: false }, ctx.fiber)` from an optional
  `ctx.inject(["settings"], ...)` child, following the shipped idiom
  (`dsh-settings/README.md:39`; `dsh-client-locale/lib/index.js:24`). It is not
  currently required — nothing shipped consumes `autoGenerate` — but it is cheap
  and matches the official pages.
- `dependencies`: `@deepseek-ai/schemastery` `^3.18.0` → `^3.18.4`.
  `.volatile()` does not exist in 3.18.2 (0 occurrences; 28 in 3.18.4).
- `peerDependencies`: added `"@deepseek-ai/dsh-settings": ">=0.1.7-rc.1"` and
  raised schemastery to `>=3.18.4`.
- The DSH gate is a **dsh-* subpackage** peer, not the `@deepseek-ai/dsh`
  umbrella. `evaluatePluginCompatibility()` treats both identically — verified by
  importing the real exported function and comparing its verdict for
  `@deepseek-ai/dsh` against `@deepseek-ai/dsh-settings` across
  `0.1.2-rc.1 / 0.1.5-rc.3 / 0.1.6-alpha.2 / 0.1.7-rc.1 / 0.1.7-rc.2` (identical
  every time: blocked on 0.1.5, allowed from 0.1.7-rc.1). The umbrella form costs
  far more: a `pnpm install --lockfile-only` comparison measured **777,850 bytes**
  for `@deepseek-ai/dsh` versus **27,725 bytes** with the subpackage — the umbrella
  resolves the entire DSH dependency graph (~600 packages) into the lockfile.
  Marking it `optional` in `peerDependenciesMeta` does NOT help (measured:
  777,588 bytes, effectively identical), because the gate reads
  `peerDependencies` and never consults that field
  (`dsh-app-boot/lib/index.js:289-301`) while pnpm's `autoInstallPeers` still
  materializes it. This also matches the shipped convention: `dsh-free-search`,
  `dsh-context`, and `@leaf233/dsh-model-relay` all gate on dsh-* subpackages.
  Lockfile growth for this release is **+464/-8 lines (~26 KB)**, down from 8,015
  lines with the umbrella peer.
- `devDependencies` holds only `@deepseek-ai/dsh-settings` — the one package the
  schema test needs in order to exercise the real helpers. The previously listed
  `dsh-client-store` / `dsh-client-ui-primitives` / `dsh-client-ui-slots`
  entries were imported by nothing and were dropped.
- `dsh.client.inject` now also declares `dsh-client-locale` and
  `dsh-client-ui-plugin-manager`.

### Removed

- **`dsh.compatibility.dshReleases`** — a dead field. It has zero occurrences in
  both the 0.1.5 and 0.1.7 trees; the real compatibility gate is
  `evaluatePluginCompatibility()` (`dsh-app-boot/lib/index.js:286-313`), which
  reads only `peerDependencies` matching `@deepseek-ai/dsh` / `dsh-*`.
- `lib/client.js`'s `RateLimiterConfig` export is now `Config` (also re-exported
  from `lib/types/index.js`).

### Added

- **`test-config-schema.mjs` (36 assertions)** — pins the contract the settings
  page depends on: `Config` yields a non-empty `volatileForm`; `models` is
  whole-block volatile and nested paths stay writable; `dict(inner.volatile())`
  is refused; and a Config with no volatile field is dropped — the regression
  guard against deleting a `.volatile()` mark.
- `test-host-integration.mjs` §13 proves volatile references are read in place:
  it mutates the reference the plugin already holds and asserts the change
  reaches the snapshot with no remount.
- `test-client-bundle.mjs` now covers the page protocol: both views, six write
  paths through `props.form.mutate` (including the nested per-model case),
  read-only/unavailable/missing-form degradation, and the `whileServed` gate.
- **`README.zh.md`** — full Simplified Chinese README, following the DSH house
  convention of a `README.md` + `README.zh.md` pair (every official package
  ships both). Both files carry a language switcher line under the badges, and
  the Chinese file is listed in `package.json`'s `files` so it ships to npm.
  Code blocks, tables, and section structure are 1:1 with the English original
  (verified: 16 fence lines, 48 table rows, 1 YAML block each).
- The "Via file" section in both languages now describes 0.1.7 accurately:
  configuration persists as the entry's own `config` in the profile's Cordis
  patch, and a legacy `settings.yaml` is imported by DSH once at first start
  (then renamed) rather than being the live store.

### Fixed (tooling and docs)

- **`test-config-schema.mjs` now exercises the REAL framework helpers.** Its
  resolution previously asked for `@deepseek-ai/dsh-settings/lib/types/schema.js`
  directly, which can never resolve — that path is not in the package's
  `exports` map (only `.`, `./types`, `./src/*`), so the suite silently fell back to a
  local re-implementation on every run. It now resolves the package ROOT and
  appends the file path, converts it with `pathToFileURL()` (a native Windows
  path makes `import()` fail with `ERR_UNSUPPORTED_ESM_URL_SCHEME`), and
  `@deepseek-ai/dsh-settings` is a devDependency so the real path is reachable.
  Confirmed by the run header switching from "\u25cb not resolvable — using
  equivalent local helpers" to "\u25cf using the real @deepseek-ai/dsh-settings
  schema helpers" (36/36 pass). The fallback branch now prints a
  `DSH_REAL_PACKAGES` hint, so a silent fallback is never mistaken for
  framework-level proof.
- **CI now runs `test-config-schema.mjs`** and `node --check`s **all seven**
  shipped lib modules (previously 5 of 6 suites and 3 files). The contract that
  decides whether the settings card exists at all — an entry with no volatile
  field is dropped (`dsh-settings/lib/index.js:419`) — had no regression
  protection in CI, while being the one failure mode that leaves the rate
  limiter working and the card silently missing.
- **CI Node matrix is now `[20, 22, 24]`** (was `[18, 20, 22]`): 18 is EOL and 24
  is the version the plugin is developed and run on.
- **`tools/verify-install.mjs` skips its install half instead of failing** when
  the plugin is not present in the profile, and falls back to importing the
  source tree. Exit codes are now 0 = fully verified, 1 = a check failed,
  2 = source-tree checks passed but the install half was skipped (the same
  contract as `tools/verify-live-route.mjs`). A local run without an installed
  profile goes from 2 misleading failures to **31 passed / 0 failed / exit 2**.
- Removed the dangling `COMPATIBILITY.md` references left when that file was
  deleted: the `package.json` `files` entry, the README badge link in both
  languages, and the closing "see COMPATIBILITY.md" links (now pointing at
  `CHANGELOG.md` and the inline source comments). The historical `CHANGELOG.md`
  mention under `[0.1.0]` is intentionally kept, and the `lib/index.js` header
  comment no longer points at the deleted file.

### Notes

- `test-3rpm.mjs` is deliberately **left out of the `test` script**. It prints
  conclusions rather than making assertions, and it re-implements
  `resolveModelConfig` instead of importing it (`test-3rpm.mjs:15-28`), so it
  cannot detect a drift between itself and `lib/index.js`. It still runs
  cleanly against 0.3.0. Converting it into a real assertion suite would mean
  exporting the resolver or driving the interceptor — out of scope for this
  migration.

### Verified

- All six suites green on DSH `0.1.7-rc.1` packages with Cordis 4.0.4,
  schemastery 3.18.4, Node 24.21.0: **19 + 61 + 106 + 80 + 73 + 36 = 375
  assertions, 0 failures**.
- `node tools/verify-install.mjs`: 37 passed, 0 failed.
- Against the **real** `@deepseek-ai/dsh-settings` service: `describe()` returns
  the entry with all six volatile fields, `autoGenerate: false`, and
  `models` unwrapped to a plain object; a nested
  `["models", "c/d", "maxRpm"]` mutation passes `write()`'s volatile gate while
  a non-volatile path is still refused (12/12).
- The status channel needs no change: the `dsh-client-connection` `inject`
  mismatch that forces the fallback is **still unfixed in 0.1.7-rc.1**
  (`dsh-client-connection/lib/index.js:798` keeps `inject = ["credentials"]`),
  so the v0.2.1 dual-path carrier continues to work as designed.
- Producer: **deepseek-v4.1-flash**.

### Migration

- On DSH 0.1.7+: install `0.3.0`. Your existing `llm-rate-limiter` configuration
  in the profile's settings/cordis patch is read as the entry's own `config`;
  no manual migration was performed by the plugin.
- On DSH 0.1.5-rc.3: keep `0.2.x`.

## [0.2.1] - 2026-09-25

### Fixed
- **Live status panel stopped working on DSH 0.1.5-rc.3** — the channel silently failed to mount and the panel sat on "○ 重试中" forever. Root cause is upstream: DSH 0.1.5-rc.3 changed `@deepseek-ai/dsh-client-connection`'s own `inject` from `["webServer", "credentials"]` to `["credentials"]`, while `HostConnectionService.register()` still dereferences `owner.webServer`. Cordis rebinds a cross-fiber service's `ctx` to the *reader's* fiber, so `connection.rpc.handle()` threw `cannot get property "webServer" without inject` — which the plugin's own try/catch swallowed.
- The plugin now falls back to a **self-registered `kind: "prefix"` route** on its own fiber (which can see `webServer`) and reuses `connection.requestRejection()` for the 403/401 fence. Both carriers speak the identical wire protocol, so **`lib/client.js` is unchanged**.

### Added
- `createChannelRoute({ channel, handler, reject })` and `endpointFromPath()` in `lib/status-rpc.js` — a Connection-RPC-compatible webserver prefix route, mirroring the framework's `rpcFetchHandler` request-shape decisions (404 / 415 / 413 / 400 / `gateway/bad-request` / 500 / 200)
- `test-status-route.mjs` (73 assertions) in four layers: route grammar, request-shape decisions, a simulated 0.1.5 regression (proves both the fallback *and* the preference for `rpc.handle` when it works), and the real 0.1.5 package (auto-skips when DSH is absent)
- `tools/verify-live-route.mjs` (19 assertions) — boots the real `dsh-host-webserver` on a real socket plus the real `dsh-client-connection`, then issues real HTTP requests; exits 2 (skipped) without a DSH install
- `pnpm run verify:live` script

### Changed
- `dsh.compatibility.dshReleases` now declares `0.1.5-rc.3` as compatible alongside `0.1.2-rc.1`
- The status channel's mount log now names the active carrier (`connection.rpc` vs `self-registered route`), and a failed path-1 registration is reported as a warning instead of being swallowed
- If `connection.requestRejection()` is unavailable or throws, the plugin **refuses to mount** rather than publishing an unauthenticated route

### Notes
- Path 1 (`connection.rpc.handle`) is still preferred: it keeps route ownership, request validation, and withdrawal with the framework. The fallback exists only for hosts where path 1 is broken.
- When DSH fixes the upstream `inject` mismatch, path 1 succeeds again and the fallback goes unused — no plugin change required.
- Verified on: DSH `0.1.5-rc.3` (client-connection 0.1.5-rc.3, host-webserver 0.1.5-rc.3), Cordis 4.0.2, Node 24.21.0. Test totals: 19 + 61 + 70 + 77 + 73 = **300 assertions**, plus 31 in `tools/verify-install.mjs` and 19 in `tools/verify-live-route.mjs`. Producer: **deepseek-v4.1-flash**.

## [0.2.0] - 2026-09-13

### Added
- **Live status panel** in the settings card: request/granted/rejected/timeout/aborted counters, average wait, per-model progress bars (token balance or window occupancy), concurrency and queue badges, and a rolling event log
- **`connection.rpc` status channel** at `/llm-rate-limiter` with `snapshot` and `reset` endpoints — the framework supplies POST+JSON transport, the Host/Origin fence (403) and browser authentication (401), and withdraws the channel with the plugin fiber
- **"清零" button** that zeroes all statistics and drops retained events
- `lib/status-rpc.js` — channel handler and envelope helpers (`success` / `failure`)
- `test-status-rpc.mjs` (61 assertions): envelopes, endpoint routing, JSON-safety, ring-buffer bounds, every counter path
- `test-client-bundle.mjs` (70 assertions): loads the real client bundle in a VM and mounts the card and panel on a miniature React runtime — covers live rendering, collapse-stops-polling, and every degraded phase

### Changed
- `dsh.client.inject` now also requires `@deepseek-ai/dsh-client-connection`, so the connection service is available before the panel mounts
- `dsh.compatibility.dshReleases` declares the verified DSH release (aligned with dsh-context's convention)
- CI runs the two new suites and syntax-checks `lib/status-rpc.js`

### Notes
- The status channel is optional: on a host without a connection service it is never registered and the panel shows "状态通道不可用" instead, leaving configuration untouched
- Statistics are in-memory only and reset when the host restarts

## [0.1.1] - 2026-09-12

### Changed
- **Package renamed to `@leaf233/dsh-llm-rate-limiter`** (npm scope) and published to npm; the internal plugin identity (`llm-rate-limiter`), settings namespace, and runtime behavior are unchanged
- `cordis.patch.yml` `name` and the browser client bundle id now follow the scoped package name (required by DSH module resolution)
- npm badge and npm install instructions added to README

### Fixed (since the `v0.1.0` git tag)
- CI: `pnpm/action-setup` now precedes `actions/setup-node` (pnpm was missing from PATH)
- CI: `pnpm-lock.yaml` committed, so `--frozen-lockfile` installs work
- Removed private `@deepseek-ai/dsh-llm` from `peerDependencies` (unresolvable for consumers)

## [0.1.0] - 2026-09-12

### Added
- Token Bucket strategy with configurable `burstSize`, `refillRate`, `maxConcurrent`
- Sliding Window strategy with `windowMs`, `maxRpm`, `maxConcurrent`
- Per-model rate limit overrides (`models["provider/model"]`)
- Queue mode: throttled requests wait and are released when slots open
- Reject mode: throttled requests fail with `RATE_LIMIT` code (compatible with `dsh-llm-retry`)
- Interactive GUI in DSH Settings → Plugins (collapsible PluginCard)
- `maxRpm` → `refillRate` auto-derivation for token-bucket when only `maxRpm` is set
- Hot-reload: settings changes take effect immediately
- `maxQueueWaitMs` timeout for queue mode
- 19 unit tests covering concurrency, burst, queue, abort, and hot-reload
- E2E test (`test-3rpm.mjs`) verifying 3 rpm limit
- DSH version compatibility analysis (COMPATIBILITY.md)