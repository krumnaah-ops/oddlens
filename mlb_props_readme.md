# MLB Player Props (The Odds API)

A production-ready MLB player-props feature: a scheduled updater that fetches
props from [The Odds API](https://the-odds-api.com), removes the vig to compute
fair odds, and caches the result in Netlify Blobs; a fast public API that serves
that cache; and a frontend page that displays it.

## Architecture

```
The Odds API ──► update-mlb-props.mts (scheduled hourly; pulls 10/12/2/4/6 CT)
                   │  /events (free) → window + relevance
                   │  /events/{id}/odds (credits) → props
                   │  no-vig normalization
                   ▼
              Netlify Blobs  (store: "mlb-props", key: "latest")
                   ▲
                   │  read-only, no upstream calls
              mlb-props.mts  ──►  GET /api/mlb-props
                   ▲
                   │  fetch + render
              mlb-props.html  (frontend)
```

### Files

| Path | Purpose |
|------|---------|
| `netlify/lib/config.ts` | **All tunables**: markets, books, window, blob keys. |
| `netlify/lib/oddsApi.ts` | The Odds API client (`/events`, `/events/{id}/odds`) + types. |
| `netlify/lib/novig.ts` | Implied-probability ↔ American odds + no-vig math. |
| `netlify/lib/window.ts` | Active-window and game-relevance logic. |
| `netlify/lib/transform.ts` | Raw odds → normalized payload with fair odds. |
| `netlify/lib/store.ts` | Netlify Blobs read/write helpers. |
| `netlify/functions/update-mlb-props.mts` | Scheduled updater (cron). |
| `netlify/functions/mlb-props.mts` | Public API at `/api/mlb-props`. |
| `mlb-props.html` | Frontend page (vanilla JS, matches site theme). |

## How it works

The updater runs **hourly**, but only pulls at the discrete Central-Time pull
hours — **10am, 12pm, 2pm, 4pm and 6pm** (every 2 hours from
`PULL_WINDOW_START_HOUR` through `PULL_WINDOW_END_HOUR` inclusive). On any other
hour the run is an immediate no-op. Running hourly and gating in an IANA
timezone keeps those wall-clock pull times correct across daylight-saving
changes (cron itself is evaluated in UTC). On a pull-hour run it first calls the
**free** `/events` endpoint to list the day's games and their start times, then
computes an **active daily window**:

```
start = earliest game time − WINDOW_START_LEAD_MINUTES   (default 120 min)
end   = latest   game time − WINDOW_END_TRAIL_MINUTES    (default 30 min)
```

- **Inside the window** it fetches player props (the credit-consuming call) for
  **relevant games only** — those starting within `RELEVANCE_LOOKAHEAD_HOURS`
  (default 8h) or currently live — removes the vig, and stores the combined
  payload in Netlify Blobs.
- **Outside the window** it does only the free `/events` check and refreshes the
  cache metadata without spending prop credits.

The public API (`/api/mlb-props`) only **reads** the blob, so visitor requests
are fast and never consume The Odds API quota.

### No-vig (fair) odds

For each Over/Under line, both prices are converted to implied probabilities,
renormalized so they sum to 100% (removing the book's hold), and converted back
to American odds. See `netlify/lib/novig.ts`.

## How to adjust things

Everything tunable lives in **`netlify/lib/config.ts`**:

- **Markets** — edit the `MARKETS` array. Each entry has a `key` (The Odds API
  market key), a `label`, and a `type` (`batter` or `pitcher`, which controls
  the UI section). The current five: `batter_home_runs`, `batter_total_bases`,
  `batter_hits_runs_rbis`, `pitcher_strikeouts`, `pitcher_outs`.
- **Bookmakers** — edit the `BOOKMAKERS` array. The current eight: `draftkings`,
  `fanduel`, `betmgm`, `williamhill_us`, `bovada`, `betonlineag`, `mybookieag`,
  `novig`.
- **Window** — change `WINDOW_START_LEAD_MINUTES` / `WINDOW_END_TRAIL_MINUTES`
  to widen or narrow the active daily window, and `RELEVANCE_LOOKAHEAD_HOURS` /
  `LIVE_GRACE_HOURS` to change which games are considered worth fetching.
- **Pull hours** — edit `PULL_WINDOW_START_HOUR`, `PULL_WINDOW_END_HOUR`,
  `PULL_WINDOW_STEP_HOURS` and `PULL_WINDOW_TZ` in `netlify/lib/config.ts` to
  change which Central-Time hours pull (default 10am–6pm every 2 hours).
- **Schedule (cadence)** — `config.schedule` in
  `netlify/functions/update-mlb-props.mts` is `0 * * * *` (hourly) so the
  function can land on the pull hours above across daylight-saving changes;
  leave it hourly and adjust the `PULL_WINDOW_*` values to retime pulls.

## Environment

Set `ODDS_API_KEY` in the site environment to a
[The Odds API](https://the-odds-api.com) key. The code reads it via
`process.env.ODDS_API_KEY`.

## Observability

Each updater run logs, via `console`:

- credits remaining (`x-requests-remaining`),
- credits used this run (summed `x-requests-last`),
- number of games processed,
- the computed active window and relevant-game count.

These values are also embedded in the cached payload and surfaced in the
frontend meta bar.
