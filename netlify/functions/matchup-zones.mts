// ---------------------------------------------------------------------------
// Public API: GET /api/matchup-zones
//
// Powers the zone-map dashboard's "Per Batter" view. Given a batter and a
// pitcher, it returns two 3x3 strike-zone grids of home-run rate per 100
// pitches — the batter's power zones against this pitcher's hand, and the
// pitcher's vulnerability zones against this batter's side — built from the
// free, public Baseball Savant Statcast pitch-level feed (no API key, no
// quota), the same data pybaseball reads.
//
// Computed payloads are small, so each matchup is cached in Netlify Blobs and
// reused for an hour. A cache miss (or ?refresh=1) fetches live from Savant.
//
// Query parameters:
//   batter=<id>     (required) MLB player id of the batter.
//   pitcher=<id>    (required) MLB player id of the pitcher.
//   batSide=L|R|S   (optional) batter's stance hint — skips a Stats-API lookup.
//   pitchHand=L|R   (optional) pitcher's throwing-hand hint.
//   batterName=…    (optional) display name hint.
//   pitcherName=…   (optional) display name hint.
//   seasons=2024,2025  (optional) seasons to aggregate. Default: prior + current.
//   refresh=1       (optional) bypass the cache and re-fetch from Savant.
// ---------------------------------------------------------------------------

import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import {
  buildMatchupZones,
  defaultSeasons,
  MatchupZonesError,
  type Hand,
  type MatchupZonesPayload,
} from "../lib/matchupZones.js";

const ATTRIBUTION =
  "Data from Baseball Savant / MLB Statcast (https://baseballsavant.mlb.com)";

const CACHE_STORE = "mlb-matchup-zones";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

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

function store() {
  return getStore({ name: CACHE_STORE, consistency: "strong" });
}

export default async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return json({}, 204);

  const url = new URL(req.url);
  const q = url.searchParams;

  const batterId = Number(q.get("batter"));
  const pitcherId = Number(q.get("pitcher"));
  if (!Number.isInteger(batterId) || !Number.isInteger(pitcherId)) {
    return json(
      { error: "Both `batter` and `pitcher` must be numeric MLB player ids." },
      400
    );
  }

  const seasons = (q.get("seasons") || "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 2000);
  const effectiveSeasons = seasons.length ? seasons : defaultSeasons();

  const refresh = truthy(q.get("refresh"));
  const cacheKey = `${batterId}_${pitcherId}_${effectiveSeasons.join("-")}`;

  try {
    // Serve a fresh-enough cached payload when present.
    if (!refresh) {
      const cached = (await store().get(cacheKey, { type: "json" })) as
        | (MatchupZonesPayload & { _cachedAt?: number })
        | null;
      if (cached && cached._cachedAt && Date.now() - cached._cachedAt < CACHE_TTL_MS) {
        return json({ ...cached, source: "cache" }, 200);
      }
    }

    const batSideRaw = (q.get("batSide") || "").toUpperCase();
    const pitchHandRaw = (q.get("pitchHand") || "").toUpperCase();

    const payload = await buildMatchupZones({
      batterId,
      pitcherId,
      batterName: q.get("batterName") || undefined,
      pitcherName: q.get("pitcherName") || undefined,
      batSide: batSideRaw || undefined,
      pitchHand: pitchHandRaw === "L" || pitchHandRaw === "R" ? (pitchHandRaw as Hand) : undefined,
      seasons: effectiveSeasons,
    });

    // Persist for reuse (best-effort; never fail the request on a write error).
    try {
      await store().setJSON(cacheKey, { ...payload, _cachedAt: Date.now() });
    } catch (err) {
      console.warn("matchup-zones: cache write failed:", err);
    }

    return json(payload, 200);
  } catch (err) {
    // Live fetch failed — fall back to any cached copy, even if stale.
    if (!refresh) {
      try {
        const stale = (await store().get(cacheKey, { type: "json" })) as
          | MatchupZonesPayload
          | null;
        if (stale) return json({ ...stale, source: "cache" }, 200);
      } catch {
        /* ignore */
      }
    }
    const status = err instanceof MatchupZonesError ? 502 : 500;
    console.error("matchup-zones API: failed to build payload:", err);
    return json(
      { error: "Failed to load matchup zone data.", attribution: ATTRIBUTION },
      status
    );
  }
};

export const config: Config = {
  path: "/api/matchup-zones",
};
