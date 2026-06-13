// ---------------------------------------------------------------------------
// Scheduled writer that keeps the `odds` table populated with real MLB game
// lines and player props from The Odds API.
//
// On each run it:
//   1. Reads ODDS_API_KEY from the environment (never hardcoded).
//   2. Discovers the slate via the free /events endpoint.
//   3. Fetches game lines + player props per event via /events/{id}/odds.
//   4. Upserts each game into the Netlify (Postgres) database.
//
// The public /api/odds endpoint (get-odds.mts) then serves these rows quickly
// without spending API credits on visitor requests. See netlify/lib/oddsFeed.ts
// for the fetch pipeline.
// ---------------------------------------------------------------------------

import type { Config } from "@netlify/functions";
import { getApiKey } from "../lib/config.js";
import { buildOddsRows, persistOddsRows } from "../lib/oddsFeed.js";
import { isWithinPullWindow } from "../lib/window.js";

export default async () => {
  // Only pull at the day's discrete Central-Time pull hours (10am, 12pm, 2pm,
  // 4pm, 6pm). This function is scheduled hourly so it can land on those exact
  // wall-clock hours year-round; on any other hour the run is a no-op and no
  // odds are pulled. The manual /pull-odds endpoint can still be used on demand
  // outside these hours.
  if (!isWithinPullWindow(new Date())) {
    console.log("fetch-odds: not a scheduled pull hour; skipping run.");
    return;
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    console.error("fetch-odds: ODDS_API_KEY is not set; skipping run.");
    return;
  }

  const rows = await buildOddsRows(apiKey);
  if (rows.length === 0) {
    console.warn("fetch-odds: no games returned this run; nothing to persist.");
    return;
  }

  const saved = await persistOddsRows(rows);

  console.log(`fetch-odds: persisted ${saved}/${rows.length} game(s) to Netlify Database.`);
};

export const config: Config = {
  // Run hourly; the function itself only pulls at the Central-Time pull hours
  // (10am, 12pm, 2pm, 4pm, 6pm). Scheduling hourly rather than every 2 hours
  // keeps those wall-clock times correct across daylight-saving changes, since
  // the cron schedule is evaluated in UTC.
  schedule: "0 * * * *",
};
