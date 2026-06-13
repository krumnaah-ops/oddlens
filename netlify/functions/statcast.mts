// ---------------------------------------------------------------------------
// Public API: GET /api/statcast
//
// Serves the Statcast exit-velocity & barrels leaderboards (the same data
// pybaseball exposes via statcast_*_exitvelo_barrels). It reads the cached
// payload written by the scheduled updater; on a cache miss — or when
// ?refresh=1 is passed — it fetches live from Baseball Savant and caches the
// result. Because Savant's leaderboard is free and unmetered, the live
// fallback is safe (unlike the Odds-API-backed props endpoint).
//
// Query parameters (all optional):
//   type=batter|pitcher|both   Which leaderboard(s) to return. Default: both.
//   year=<season>              Season to fetch. Default: current season.
//   min=<bbe>|q                Minimum batted-ball events ("q" = qualified).
//   refresh=1                  Bypass the cache and re-fetch from Savant.
//   limit=<n>                  Cap each leaderboard to the top N rows.
// ---------------------------------------------------------------------------

import type { Config } from "@netlify/functions";
import { currentSeasonYear, STATCAST_MIN_BBE } from "../lib/config.js";
import {
  buildStatcastPayload,
  StatcastError,
  type StatcastPayload,
} from "../lib/statcast.js";
import { loadStatcast, saveStatcast } from "../lib/statcastStore.js";

const ATTRIBUTION =
  "Data from Baseball Savant / MLB Statcast (https://baseballsavant.mlb.com)";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}

function truthy(v: string | null): boolean {
  if (!v) return false;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export default async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return json({}, 204);

  const url = new URL(req.url);
  const q = url.searchParams;

  const type = (q.get("type") || "both").toLowerCase();
  const season = Number(q.get("year")) || currentSeasonYear();
  const min = q.get("min") || STATCAST_MIN_BBE;
  const refresh = truthy(q.get("refresh"));
  const limitRaw = Number(q.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : null;

  // Only the canonical (current season, default minimum) view is cached. Ad-hoc
  // requests for other seasons / minimums are fetched live and not cached.
  const isDefault = season === currentSeasonYear() && min === STATCAST_MIN_BBE;

  try {
    let payload: StatcastPayload | null = null;

    if (isDefault && !refresh) {
      payload = await loadStatcast();
      if (payload) payload = { ...payload, source: "cache" };
    }

    if (!payload) {
      try {
        payload = await buildStatcastPayload(season, min);
        if (isDefault) await saveStatcast(payload);
      } catch (err) {
        // Live fetch failed — fall back to any cached copy before giving up.
        const cached = isDefault ? await loadStatcast() : null;
        if (cached) {
          payload = { ...cached, source: "cache" };
        } else {
          throw err;
        }
      }
    }

    // Shape the response per the requested type and optional limit.
    const cap = (rows: StatcastPayload["batters"]) =>
      limit ? rows.slice(0, limit) : rows;

    const batters = type === "pitcher" ? [] : cap(payload.batters);
    const pitchers = type === "batter" ? [] : cap(payload.pitchers);

    return json(
      {
        generatedAt: payload.generatedAt,
        season: payload.season,
        minBattedBalls: payload.minBattedBalls,
        source: payload.source,
        type,
        counts: { batters: batters.length, pitchers: pitchers.length },
        batters,
        pitchers,
        attribution: payload.attribution || ATTRIBUTION,
      },
      200
    );
  } catch (err) {
    const status = err instanceof StatcastError ? 502 : 500;
    console.error("statcast API: failed to load leaderboard:", err);
    return json(
      {
        error: "Failed to load Statcast leaderboard.",
        attribution: ATTRIBUTION,
      },
      status
    );
  }
};

export const config: Config = {
  path: "/api/statcast",
};
