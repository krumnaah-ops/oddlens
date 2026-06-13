// ---------------------------------------------------------------------------
// Scheduled updater for MLB player props.
//
// Runs every 2 hours (see `config.schedule`). On each run it:
//   1. Calls the FREE /events endpoint to discover the day's games + times.
//   2. Computes the active daily window dynamically from those times.
//   3. INSIDE the window: fetches per-event props (the credit-consuming call)
//      for relevant games only (starting within 8h or live), removes the vig,
//      and stores the combined payload in Netlify Blobs.
//   4. OUTSIDE the window: performs only the lightweight /events check and
//      refreshes the cached payload's metadata without spending prop credits.
//
// Tuning lives in netlify/lib/config.ts. See MLB_PROPS_README.md.
// ---------------------------------------------------------------------------

import type { Config } from "@netlify/functions";
import { getApiKey } from "../lib/config.js";
import { fetchEvents, fetchEventOdds, OddsApiError } from "../lib/oddsApi.js";
import { computeActiveWindow, relevantEvents, isWithinPullWindow } from "../lib/window.js";
import { transformEvent } from "../lib/transform.js";
import type { GameProps, PropsPayload } from "../lib/transform.js";
import { savePayload, loadPayload } from "../lib/store.js";

const ATTRIBUTION = "Data from The Odds API (https://the-odds-api.com)";

export default async () => {
  const startedAt = new Date();

  // Only pull at the day's discrete Central-Time pull hours (10am, 12pm, 2pm,
  // 4pm, 6pm). This function is scheduled hourly so it can land on those exact
  // wall-clock hours year-round; on any other hour the run is a no-op — not even
  // the free /events check fires — so no odds are pulled. The manual /pull-odds
  // endpoint remains available on demand.
  if (!isWithinPullWindow(startedAt)) {
    console.log("mlb-props updater: not a scheduled pull hour; skipping run.");
    return;
  }

  const apiKey = getApiKey();

  if (!apiKey) {
    console.error("mlb-props updater: ODDS_API_KEY is not set; nothing to do.");
    return;
  }

  // --- 1. Free events check ------------------------------------------------
  let events;
  try {
    const result = await fetchEvents(apiKey);
    events = result.events;
    console.log(
      `mlb-props updater: /events returned ${events.length} game(s); ` +
        `credits remaining=${result.meta.requestsRemaining ?? "n/a"}`
    );
  } catch (err) {
    if (err instanceof OddsApiError && err.isQuota) {
      console.error("mlb-props updater: API quota exhausted on /events; skipping run.");
    } else {
      console.error("mlb-props updater: /events failed:", err);
    }
    return;
  }

  // --- 2. Decide window ----------------------------------------------------
  const window = computeActiveWindow(events, startedAt);
  const relevant = relevantEvents(events, startedAt);

  console.log(
    `mlb-props updater: window active=${window.active} ` +
      `(${window.startsAt?.toISOString() ?? "n/a"} -> ${
        window.endsAt?.toISOString() ?? "n/a"
      }); relevant games=${relevant.length}`
  );

  const baseWindow = {
    active: window.active,
    startsAt: window.startsAt ? window.startsAt.toISOString() : null,
    endsAt: window.endsAt ? window.endsAt.toISOString() : null,
  };

  // --- 3. Outside the window (or nothing relevant): lightweight refresh ----
  if (!window.active || relevant.length === 0) {
    const previous = await loadPayload();
    const payload: PropsPayload = {
      generatedAt: startedAt.toISOString(),
      source: "lightweight",
      window: baseWindow,
      creditsRemaining: previous?.creditsRemaining ?? null,
      creditsUsedThisRun: 0,
      // Preserve last-known props so the public API keeps serving fresh-ish data.
      gamesProcessed: 0,
      games: previous?.games ?? [],
      attribution: ATTRIBUTION,
    };
    await savePayload(payload);
    console.log(
      "mlb-props updater: lightweight run complete (no prop credits spent)."
    );
    return;
  }

  // --- 4. Inside the window: fetch props for relevant games ----------------
  console.log(
    `mlb-props updater: fetching props for ${relevant.length} relevant game(s) in parallel...`
  );

  const results = await Promise.all(
    relevant.map((e) => fetchEventOdds(apiKey, e.id))
  );

  const games: GameProps[] = [];
  let creditsRemaining: number | null = null;
  let creditsUsed = 0;
  let failures = 0;

  results.forEach((res, i) => {
    if (res.meta.requestsRemaining != null) creditsRemaining = res.meta.requestsRemaining;
    if (res.meta.requestsLast != null) creditsUsed += res.meta.requestsLast;

    if (res.data) {
      games.push(transformEvent(res.data));
    } else {
      failures++;
      // Keep a placeholder so the game still appears (with empty props).
      const ev = relevant[i];
      games.push({
        eventId: ev.id,
        sportKey: ev.sport_key,
        commenceTime: ev.commence_time,
        homeTeam: ev.home_team,
        awayTeam: ev.away_team,
        batterProps: [],
        pitcherProps: [],
      });
    }
  });

  // Sort games by commence time for a tidy UI.
  games.sort(
    (a, b) =>
      new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime()
  );

  const payload: PropsPayload = {
    generatedAt: startedAt.toISOString(),
    source: "live",
    window: baseWindow,
    creditsRemaining,
    creditsUsedThisRun: creditsUsed,
    gamesProcessed: games.length,
    games,
    attribution: ATTRIBUTION,
  };

  await savePayload(payload);

  console.log(
    `mlb-props updater: done. gamesProcessed=${games.length} ` +
      `failures=${failures} creditsUsedThisRun=${creditsUsed} ` +
      `creditsRemaining=${creditsRemaining ?? "n/a"}`
  );
};

export const config: Config = {
  // Run hourly; the function itself enforces the discrete Central-Time pull
  // hours (10am, 12pm, 2pm, 4pm, 6pm) and only spends prop credits when on one
  // of those hours with relevant games. Scheduling hourly keeps those
  // wall-clock times correct across daylight-saving changes.
  schedule: "0 * * * *",
};
