# Changelog

## 0.2.0 — 2026-10-25

- Apply RPM and HTTP concurrency limits per upstream origin.
- Share each site's quota across models, parent Agents, SubAgents, tool loops and retries.
- Route current-model snapshots and independent saved connections automatically, retaining original model names and IDs.
- Add a site rules panel, per-site queue counters and independent quotas.
- Migrate 0.1 bindings and remove unused prefixed model targets, retaining user edits and backups.
- Restore direct connections when a site rule is disabled.
- Include 21 queue, relay, routing, panel and migration tests.

## 0.1.0 — 2026-10-25

- Initial local prototype using manually selected managed model copies.
- Replaced by automatic site routing in 0.2.0.
