// ---------------------------------------------------------------------------
// Scheduled updater for Statcast exit-velocity & barrel leaderboards.
//
// Runs once a day (see `config.schedule`). Each run fetches the current
// season's batter and pitcher exit-velocity & barrels leaderboards from
// Baseball Savant and caches the combined payload in Netlify Blobs so the
// public /api/statcast endpoint can serve it instantly.
//
// Savant's leaderboard is free and unmetered, so there is no quota to protect;
// the daily cadence simply keeps the cache warm. The public endpoint also
// refreshes on a cache miss, so the feature works before the first cron run.
// ---------------------------------------------------------------------------

import type { Config } from "@netlify/functions";
import { currentSeasonYear, STATCAST_MIN_BBE } from "../lib/config.js";
import { buildStatcastPayload } from "../lib/statcast.js";
import { saveStatcast } from "../lib/statcastStore.js";

export default async () => {
  const season = currentSeasonYear();

  try {
    const payload = await buildStatcastPayload(season, STATCAST_MIN_BBE);
    await saveStatcast(payload);
    console.log(
      `statcast updater: cached season=${season} ` +
        `batters=${payload.counts.batters} pitchers=${payload.counts.pitchers}`
    );
  } catch (err) {
    // Leave the previous cache in place; the public endpoint can still serve it.
    console.error("statcast updater: failed to refresh leaderboard:", err);
  }
};

export const config: Config = {
  // Once daily at 11:17 UTC (~early morning US), after the prior night's games
  // have settled. Edit this cron to change the cadence.
  schedule: "17 11 * * *",
};
