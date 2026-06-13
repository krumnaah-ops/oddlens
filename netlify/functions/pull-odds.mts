// ---------------------------------------------------------------------------
// Admin-only manual trigger: POST/GET /.netlify/functions/pull-odds
//
// Runs the exact same pipeline as the scheduled writer (fetch-odds.mts) on
// demand: discover the slate via the free /events endpoint, fetch game lines +
// player props per event, and upsert every game into the Netlify (Postgres)
// database. Use it to populate the database immediately rather than waiting for
// the next 2-hour scheduled run.
//
// Access is restricted with a simple shared secret. Set the ADMIN_PULL_KEY
// environment variable on the site, then supply the same value on each request
// via any one of:
//   - header  `X-Admin-Key: <secret>`
//   - header  `Authorization: Bearer <secret>`
//   - query   `?key=<secret>`
// If ADMIN_PULL_KEY is not configured the endpoint refuses all requests (503),
// so it can never be left unintentionally open.
//
// The heavy lifting (fetch + persist) reuses the shared feed module
// (netlify/lib/oddsFeed.ts), so this endpoint stays a thin auth + summary layer.
// ---------------------------------------------------------------------------

import type { Config } from "@netlify/functions";
import { timingSafeEqual } from "node:crypto";
import { getApiKey } from "../lib/config.js";
import { buildOddsRows, persistOddsRows } from "../lib/oddsFeed.js";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Constant-time string comparison that is safe on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Pull the caller-supplied secret from header or query string. */
function providedSecret(req: Request): string {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.replace(/^Bearer\s+/i, "");
  return (
    req.headers.get("x-admin-key") ||
    bearer ||
    new URL(req.url).searchParams.get("key") ||
    ""
  );
}

export default async (req: Request) => {
  // --- Auth ----------------------------------------------------------------
  const expected = process.env.ADMIN_PULL_KEY;
  if (!expected) {
    console.error("pull-odds: ADMIN_PULL_KEY is not configured; refusing.");
    return json(
      { error: "Endpoint not configured. Set ADMIN_PULL_KEY to enable it." },
      503
    );
  }
  if (!safeEqual(providedSecret(req), expected)) {
    return json({ error: "Unauthorized." }, 401);
  }

  // --- Same pipeline as the scheduled writer -------------------------------
  const apiKey = getApiKey();
  if (!apiKey) {
    console.error("pull-odds: ODDS_API_KEY is not set; cannot pull.");
    return json({ error: "ODDS_API_KEY is not set on the site." }, 500);
  }

  try {
    const rows = await buildOddsRows(apiKey);
    if (rows.length === 0) {
      console.warn("pull-odds: no games returned; nothing to persist.");
      return json(
        {
          ok: true,
          gamesFetched: 0,
          gamesSaved: 0,
          message: "No games in the current slate; nothing to persist.",
        },
        200
      );
    }

    const saved = await persistOddsRows(rows);
    const withProps = rows.filter(
      (r) => ((r.propsData as any)?.bookmakers?.length ?? 0) > 0
    ).length;

    console.log(
      `pull-odds: persisted ${saved}/${rows.length} game(s); ${withProps} with props.`
    );

    return json(
      {
        ok: true,
        gamesFetched: rows.length,
        gamesSaved: saved,
        gamesWithProps: withProps,
        message: `Persisted ${saved}/${rows.length} game(s) to the database.`,
      },
      200
    );
  } catch (error: any) {
    console.error("pull-odds: unhandled error:", error);
    return json({ error: error?.message ?? "Internal error" }, 500);
  }
};

export const config: Config = {
  // Manual trigger only — supports both POST (correct for a mutating action)
  // and GET (convenient to fire from a browser with ?key=...).
  method: ["POST", "GET"],
};
