// ---------------------------------------------------------------------------
// Public API: GET /api/odds
//
// Serves the MLB game lines + player props that power the dashboard. Each row
// has the shape the frontend expects:
//   { eventId, sportKey, homeTeam, awayTeam, commenceTime,
//     oddsData:  { ..., bookmakers: [ game-line markets ] },
//     propsData: { ..., bookmakers: [ player-prop markets ] },
//     updatedAt }
//
// Data is normally produced by the scheduled writer (fetch-odds.mts) and read
// straight from the Netlify (Postgres) database, so visitor requests are fast
// and never spend API credits. If the stored data is missing or stale (e.g.
// before the first scheduled run), this endpoint performs a single live refresh
// via the events -> per-event-odds pipeline and persists the result.
//
// Pass `?refresh=true` to force a live refresh on demand, bypassing both the
// in-memory cache and the staleness check. The freshly fetched slate is
// persisted before it is returned.
// ---------------------------------------------------------------------------

import { db } from "../../db/index.js";
import { odds } from "../../db/schema.js";
import type { Config } from "@netlify/functions";
import { getApiKey } from "../lib/config.js";
import { buildOddsRows, persistOddsRows, scopeRowsForSite } from "../lib/oddsFeed.js";
import type { OddsRow } from "../lib/oddsFeed.js";

// Stored data older than this triggers a live refresh on read. Kept short so a
// visitor never sees odds that are badly out of date: if the scheduled writer
// has not run recently (or is outside its pull window while games are live), the
// first read past this threshold refreshes from The Odds API and re-persists.
const STALE_MS = 30 * 60 * 1000; // 30 minutes
// Very short in-memory cache to coalesce bursts of requests on a warm instance.
// This only ever serves data already in the database, so a tight TTL costs
// nothing (no API credits) and keeps the 30s-polling dashboard close to live.
const MEM_TTL_MS = 60 * 1000; // 1 minute

let memCache: { data: unknown[]; ts: number } | null = null;

async function readStoredRows(): Promise<any[]> {
  try {
    return await db.select().from(odds);
  } catch (err) {
    console.error("get-odds: database read failed:", err);
    return [];
  }
}

async function persist(rows: OddsRow[]): Promise<void> {
  await persistOddsRows(rows);
}

function latestUpdate(rows: any[]): number {
  let latest = 0;
  for (const r of rows) {
    const t = r.updatedAt ? new Date(r.updatedAt).getTime() : 0;
    if (t > latest) latest = t;
  }
  return latest;
}

async function getOdds(force = false): Promise<unknown[]> {
  // 1. Warm in-memory cache (skipped when a refresh is forced).
  if (!force && memCache && Date.now() - memCache.ts < MEM_TTL_MS) {
    return memCache.data;
  }

  // 2. Database (the primary source; kept fresh by the scheduled writer).
  const stored = await readStoredRows();
  const fresh =
    !force &&
    stored.length > 0 &&
    Date.now() - latestUpdate(stored) < STALE_MS;

  if (fresh) {
    console.log(`get-odds: serving ${stored.length} game(s) from database.`);
    memCache = { data: stored, ts: Date.now() };
    return stored;
  }

  // 3. Missing, stale, or a forced refresh: attempt a single live refresh,
  //    then persist.
  const apiKey = getApiKey();
  if (apiKey) {
    console.log(
      force
        ? "get-odds: refresh=true; forcing a live fetch from The Odds API..."
        : stored.length === 0
        ? "get-odds: no stored odds; fetching live from The Odds API..."
        : "get-odds: stored odds are stale; refreshing live from The Odds API..."
    );
    const live = await buildOddsRows(apiKey);
    if (live.length > 0) {
      await persist(live);
      memCache = { data: live, ts: Date.now() };
      return live;
    }
    console.warn("get-odds: live refresh returned no games.");
  } else {
    console.warn("get-odds: ODDS_API_KEY not set; serving stored odds only.");
  }

  // 4. Fall back to whatever is stored (possibly stale, possibly empty).
  memCache = { data: stored, ts: Date.now() };
  return stored;
}

export default async (req: Request) => {
  try {
    const force = new URL(req.url).searchParams.get("refresh") === "true";
    const data = await getOdds(force);
    // Scope the response to exactly the sportsbooks shown on the site and the
    // current slate before serving. The write path only ever upserts the current
    // slate scoped to the configured books, but it never deletes, so storage can
    // still hold finished games or rows written by an older, wider pipeline. This
    // guarantees the dashboard only ever receives on-config books + live games.
    const scoped = scopeRowsForSite(data as any[]);
    return new Response(JSON.stringify(scoped), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET",
        // Do not let browsers (mobile Safari/Chrome are especially aggressive)
        // cache the slate. The dashboard polls every 30s and the function
        // already coalesces load via its own in-memory + DB cache, so there is
        // nothing to gain from an HTTP cache and a lot to lose: a cached
        // response makes the odds look frozen on phones.
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  } catch (error: any) {
    console.error("get-odds: unhandled error:", error);
    return new Response(JSON.stringify({ error: error?.message ?? "Internal error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const config: Config = {
  path: "/api/odds",
};
