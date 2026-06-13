// ---------------------------------------------------------------------------
// Public API: GET /api/mlb-props
//
// Serves the latest cached props payload from Netlify Blobs. This endpoint
// performs NO calls to The Odds API on visitor requests — it only reads the
// blob written by the scheduled updater, so it is fast and never burns quota.
// ---------------------------------------------------------------------------

import type { Config } from "@netlify/functions";
import { loadPayload } from "../lib/store.js";

const ATTRIBUTION = "Data from The Odds API (https://the-odds-api.com)";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      // No HTTP caching: a cached response makes the manual Refresh button a
      // no-op on phones (mobile browsers serve the stale body instead of
      // re-requesting). The blob read is already cheap.
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}

export default async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return json({}, 204);

  try {
    const payload = await loadPayload();

    if (!payload) {
      // Nothing cached yet (updater hasn't run, or no slate). Return an empty,
      // well-formed payload so the frontend can render an empty state.
      return json(
        {
          generatedAt: null,
          source: "empty",
          window: { active: false, startsAt: null, endsAt: null },
          creditsRemaining: null,
          creditsUsedThisRun: 0,
          gamesProcessed: 0,
          games: [],
          attribution: ATTRIBUTION,
          note: "No cached props available yet. The updater runs on a schedule.",
        },
        200
      );
    }

    return json(payload, 200);
  } catch (err) {
    console.error("mlb-props API: failed to read cached payload:", err);
    return json({ error: "Failed to load cached MLB props." }, 500);
  }
};

export const config: Config = {
  path: "/api/mlb-props",
};
