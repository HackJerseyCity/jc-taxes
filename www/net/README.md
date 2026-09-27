# Download-size suite

`pnpm net` loads real user flows from a deployed site with a cold cache and records what each downloads, by kind:

| kind | what |
|---|---|
| `data` | map data (`/d/…`, DVC cache via the `jct-edge` Worker) |
| `api` | `/api/*` (D1-backed app data) |
| `app` | the SPA's own HTML / JS / CSS / images |
| `files` | the `/files` browser's listing / parquet API (`jct-files` Worker) |
| `basemap` | third-party map tiles / styles (reported, not checked) |

Each flow is checked against `baseline.json`:
- the list of `data` / `api` resources fetched must match exactly (data files named via the deployed bundle's DVC map, e.g. `taxes-2025-lots.geojson`), so an extra or missing fetch fails;
- `data`, `api` and `app` transfer bytes may not grow more than 10% (or 20 KB).

```bash
pnpm net                                                    # check prod (https://jct.rbw.sh)
NET_BASE=https://jct-edge.ryan-0dc.workers.dev pnpm net     # check another deploy
pnpm net:update                                             # rewrite baseline.json, append history.jsonl
```

`history.jsonl` has one line per `net:update`: date, git sha, base URL, and transfer bytes per flow × kind, so improvements (and regressions) are visible over time. Update it when a change intentionally moves the numbers, in the same commit.

Flows are defined in `flows.spec.ts` (`FLOWS`).
