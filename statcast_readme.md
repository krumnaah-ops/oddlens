# Statcast Exit Velocity & Barrels (Baseball Savant)

A pybaseball-style integration that fetches MLB **exit velocity** and **barrel**
metrics from [Baseball Savant](https://baseballsavant.mlb.com) (MLB Statcast),
caches them in Netlify Blobs, and serves them through a fast public API and a
leaderboard page.

This reads the exact same free, public leaderboard that pybaseball's
[`statcast_batter_exitvelo_barrels`](https://github.com/jldbc/pybaseball) and
`statcast_pitcher_exitvelo_barrels` functions use — no API key and no usage
quota are involved.

## Architecture

```
Baseball Savant ──► update-statcast.mts (scheduled, daily)
  /leaderboard/statcast?type=batter|pitcher&year=…&min=q&csv=true
                   │  quote-aware CSV parse → normalized records
                   ▼
              Netlify Blobs  (store: "mlb-statcast", key: "latest")
                   ▲
                   │  read; refresh from Savant on a cache miss
              statcast.mts  ──►  GET /api/statcast
                   ▲
                   │  fetch + render
              statcast.html  (frontend leaderboard)
```

### Files

| Path | Purpose |
|------|---------|
| `netlify/lib/config.ts` | Statcast tunables (Savant base URL, leaderboard path, min BBE, blob keys, season helper). |
| `netlify/lib/statcast.ts` | Savant client: CSV fetch + quote-aware parser + normalized record/payload types. |
| `netlify/lib/statcastStore.ts` | Netlify Blobs read/write helpers for the cached payload. |
| `netlify/functions/update-statcast.mts` | Scheduled daily updater (cron). |
| `netlify/functions/statcast.mts` | Public API at `/api/statcast`. |
| `statcast.html` | Frontend leaderboard page (sortable, batter/pitcher toggle, search). |

## How it works

The scheduled updater runs **once a day** (`17 11 * * *` UTC). Each run fetches
the current season's batter and pitcher exit-velocity & barrels leaderboards in
parallel and writes the combined payload to Netlify Blobs.

The public API (`/api/statcast`) serves that cached payload. Because Savant's
leaderboard is free and unmetered, the endpoint also **fetches live on a cache
miss** (and when `?refresh=1` is passed), so the feature works immediately — even
before the first cron run — and self-heals if the cache is ever empty.

### The CSV quirk

Savant's leaderboard CSV's first column header is literally
`last_name, first_name` — a single quoted field that contains a comma. A naive
`split(",")` mangles every row, so `netlify/lib/statcast.ts` uses a small
quote-aware CSV parser and addresses columns by header name.

## Metrics returned

Each record (per player) includes:

| Field | Savant column | Meaning |
|-------|---------------|---------|
| `battedBallEvents` | `attempts` | Batted-ball events |
| `avgExitVelocity` | `avg_hit_speed` | Average exit velocity (mph) |
| `maxExitVelocity` | `max_hit_speed` | Max exit velocity (mph) |
| `avgBestExitVelocity` | `ev50` | Avg EV of the hardest-hit 50% of BBE |
| `flyballLinedriveExitVelocity` | `fbld` | Avg EV on fly balls & line drives |
| `groundballExitVelocity` | `gb` | Avg EV on ground balls |
| `hardHitCount` / `hardHitPct` | `ev95plus` / `ev95percent` | Balls hit 95+ mph (count & %) |
| `barrels` / `barrelPct` / `barrelsPerPa` | `barrels` / `brl_percent` / `brl_pa` | Barrel count, barrels per BBE, barrels per PA |
| `sweetSpotPct` | `anglesweetspotpercent` | Share of BBE in the 8–32° sweet spot |
| `avgLaunchAngle` | `avg_hit_angle` | Average launch angle (°) |
| `avgDistance` / `maxDistance` / `avgHomeRunDistance` | `avg_distance` / `max_distance` / `avg_hr_distance` | Hit distances (ft) |

## API

`GET /api/statcast`

| Query param | Default | Description |
|-------------|---------|-------------|
| `type` | `both` | `batter`, `pitcher`, or `both`. |
| `year` | current season | Season to fetch. |
| `min` | `q` | Minimum batted-ball events (`q` = qualified, or a number). |
| `refresh` | `0` | `1` bypasses the cache and re-fetches from Savant. |
| `limit` | — | Cap each leaderboard to the top N rows. |

Only the canonical view (current season, qualified) is cached; requests for
other seasons or minimums are fetched live and not cached.

Example response (truncated):

```json
{
  "generatedAt": "2026-06-12T11:17:03.000Z",
  "season": 2026,
  "minBattedBalls": "q",
  "source": "cache",
  "type": "both",
  "counts": { "batters": 250, "pitchers": 180 },
  "batters": [
    {
      "playerId": 605141,
      "player": "Mookie Betts",
      "battedBallEvents": 531,
      "avgExitVelocity": 89.1,
      "maxExitVelocity": 108.4,
      "barrels": 29,
      "barrelPct": 5.5,
      "hardHitPct": 35.8
    }
  ],
  "pitchers": []
}
```

## How to adjust things

- **Season / minimum** — defaults live in `netlify/lib/config.ts`
  (`currentSeasonYear()`, `STATCAST_MIN_BBE`); per-request overrides via the
  `year` / `min` query params.
- **Cadence** — edit `config.schedule` in
  `netlify/functions/update-statcast.mts`.
- **Leaderboard columns shown** — edit the `COLUMNS` array in `statcast.html`.

No environment variables are required.
