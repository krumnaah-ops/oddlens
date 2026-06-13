import type { Config } from "@netlify/functions";
import { db } from "../../db/index.js";
import { odds } from "../../db/schema.js";

// MLB odds endpoint backed by the-odds-api.com.
//
// Unlike the broader fetch-odds/get-odds functions (which pull every US book
// and filter afterwards), this endpoint asks the-odds-api directly for only
// the three requested books via the `bookmakers` query parameter, in addition
// to `regions=us`. It returns game lines plus home run and pitcher player props.
//
// Flow:
//   1. Fetch game odds (h2h/spreads/totals) for the slate in a single call.
//   2. For each game, fetch player props from the per-event odds endpoint.
//      These run in parallel and a failure on one game never aborts the rest.
//   3. Combine game odds + props into one response.
//
// Query parameters (all control whether props are fetched; default is ON):
//   props=true|false        -> explicit toggle for props (true is the default).
//                              Accepts true/false/1/0/yes/no/on/off.
//   include=props|games     -> alternative toggle, kept for compatibility.
//                              include=games is equivalent to props=false.
//
// When the live API is unavailable (most commonly an exhausted usage quota,
// which the-odds-api reports as HTTP 401 OUT_OF_USAGE_CREDITS), the endpoint
// degrades gracefully by serving the most recent odds stored in the database
// rather than failing outright.

const ODDS_API_BASE = "https://api.the-odds-api.com/v4";
const SPORT = "baseball_mlb";

// Books requested for this endpoint. The Odds API `bookmakers` parameter
// scopes the response to just these, which keeps payloads small and avoids
// burning quota on books we don't care about.
const BOOKMAKER_KEYS = ["fanduel", "draftkings", "betmgm"];
const BOOKMAKERS = BOOKMAKER_KEYS.join(",");
const REGIONS = "us";

// Game-level markets.
const GAME_MARKETS = ["h2h", "spreads", "totals"].join(",");

// Player prop markets: home run hitters plus the common pitcher props. These
// are only available on the per-event odds endpoint, not the bulk endpoint.
const PROP_MARKETS = [
  "batter_home_runs",
  "pitcher_strikeouts",
  "pitcher_outs",
  "pitcher_hits_allowed",
  "pitcher_walks",
].join(",");

const ODDS_FORMAT = "american";

interface Bookmaker {
  key: string;
  title?: string;
  markets?: unknown[];
}

interface OddsEvent {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers?: Bookmaker[];
}

// Result of a single per-event props fetch. Carries enough detail for the
// caller to combine the data and to log exactly what happened per game.
interface PropFetchResult {
  eventId: string;
  ok: boolean;
  status: number | null;
  bookmakers: Bookmaker[];
  error?: string;
}

function getApiKey(): string | null {
  return (
    process.env.ODDS_API_KEY ||
    process.env.THE_ODDS_API_KEY ||
    (typeof Netlify !== "undefined" && Netlify.env
      ? Netlify.env.get("ODDS_API_KEY") || Netlify.env.get("THE_ODDS_API_KEY")
      : null) ||
    null
  );
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    },
  });
}

// Resolve whether player props should be fetched for this request.
//
// Precedence:
//   - `props` (explicit toggle) wins when present.
//   - otherwise `include` is honoured (include=games disables props).
//   - default is true, so a bare /api/mlb-odds still returns props.
function resolveIncludeProps(url: URL): boolean {
  const propsParam = url.searchParams.get("props");
  if (propsParam !== null) {
    const v = propsParam.trim().toLowerCase();
    return !["false", "0", "no", "off", "none"].includes(v);
  }

  const includeParam = url.searchParams.get("include");
  if (includeParam === null) return true;
  const tokens = includeParam
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  // include=props (or any list containing "props") enables; include=games
  // (anything without "props") disables.
  return tokens.includes("props");
}

// Keep only the books this endpoint advertises, so live and database-sourced
// responses share the same scope and shape.
function filterBooks(bookmakers: unknown): Bookmaker[] {
  if (!Array.isArray(bookmakers)) return [];
  return (bookmakers as Bookmaker[]).filter(
    (b) => b && typeof b.key === "string" && BOOKMAKER_KEYS.includes(b.key)
  );
}

// the-odds-api signals an exhausted plan with HTTP 429, but also with HTTP 401
// carrying an OUT_OF_USAGE_CREDITS error code. Treat both as a quota condition
// so callers get an accurate signal rather than a generic auth/upstream error.
function isQuotaError(status: number, body: string): boolean {
  if (status === 429) return true;
  if (status === 401 && body.includes("OUT_OF_USAGE_CREDITS")) return true;
  return false;
}

// Fetch the home run + pitcher props for a single event. Always resolves (never
// throws) so a failing game degrades to "no props" instead of aborting the whole
// response. The reason for any failure is logged and returned for diagnostics.
async function fetchEventProps(
  apiKey: string,
  eventId: string
): Promise<PropFetchResult> {
  const url =
    `${ODDS_API_BASE}/sports/${SPORT}/events/${eventId}/odds/` +
    `?apiKey=${apiKey}&regions=${REGIONS}&bookmakers=${BOOKMAKERS}` +
    `&markets=${PROP_MARKETS}&oddsFormat=${ODDS_FORMAT}`;

  try {
    const res = await fetch(url);

    if (!res.ok) {
      // Log the body, not just the status: the-odds-api explains *why* here
      // (e.g. INVALID_MARKET, OUT_OF_USAGE_CREDITS), which is exactly what we
      // need to diagnose empty props.
      const detail = await res.text().catch(() => "");
      console.warn(
        `mlb-odds: props request for event ${eventId} failed ` +
          `(status ${res.status})${detail ? `: ${detail}` : ""}`
      );
      return { eventId, ok: false, status: res.status, bookmakers: [], error: detail };
    }

    const data = (await res.json()) as OddsEvent;
    const books = filterBooks(data?.bookmakers);
    return { eventId, ok: true, status: res.status, bookmakers: books };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`mlb-odds: error fetching props for event ${eventId}:`, message);
    return { eventId, ok: false, status: null, bookmakers: [], error: message };
  }
}

// Serve the most recent odds stored in the database. Used when the live API is
// unavailable. Returns null when there is nothing usable to serve.
async function buildFromDatabase(includeProps: boolean): Promise<any[] | null> {
  try {
    const rows = await db.select().from(odds);
    if (!rows || rows.length === 0) return null;

    return rows.map((row) => {
      const oddsData = (row.oddsData as any) || {};
      const propsData = (row.propsData as any) || {};
      return {
        id: row.eventId,
        sport_key: row.sportKey,
        sport_title: oddsData.sport_title ?? "MLB",
        commence_time: row.commenceTime
          ? new Date(row.commenceTime).toISOString()
          : oddsData.commence_time ?? null,
        home_team: row.homeTeam,
        away_team: row.awayTeam,
        game_odds: filterBooks(oddsData.bookmakers),
        player_props: includeProps ? filterBooks(propsData.bookmakers) : [],
      };
    });
  } catch (err) {
    console.error("mlb-odds: database fallback failed:", err);
    return null;
  }
}

function successBody(
  events: any[],
  source: "live" | "cache",
  opts: { note?: string; includeProps?: boolean; diagnostics?: Record<string, unknown> } = {}
) {
  return {
    sport: SPORT,
    regions: REGIONS,
    bookmakers: BOOKMAKER_KEYS,
    source,
    props: opts.includeProps ?? true,
    ...(opts.note ? { note: opts.note } : {}),
    ...(opts.diagnostics ? { diagnostics: opts.diagnostics } : {}),
    count: events.length,
    events,
  };
}

export default async (req: Request): Promise<Response> => {
  const includeProps = resolveIncludeProps(new URL(req.url));

  const apiKey = getApiKey();

  // 1. Try the live API when a key is configured.
  if (apiKey) {
    const gameUrl =
      `${ODDS_API_BASE}/sports/${SPORT}/odds/` +
      `?apiKey=${apiKey}&regions=${REGIONS}&bookmakers=${BOOKMAKERS}` +
      `&markets=${GAME_MARKETS}&oddsFormat=${ODDS_FORMAT}`;

    try {
      console.log(
        `mlb-odds: fetching game lines (books=${BOOKMAKERS}, props=${includeProps})`
      );
      const response = await fetch(gameUrl);

      if (response.ok) {
        const events = (await response.json()) as OddsEvent[];
        const gamesFetched = Array.isArray(events) ? events.length : 0;
        console.log(`mlb-odds: fetched ${gamesFetched} game(s) from the-odds-api`);

        if (gamesFetched > 0) {
          // Enrich each game with props. All per-event requests are kicked off
          // up front so they run in parallel; Promise.all waits for the slate.
          let propResults: (PropFetchResult | null)[] = [];
          if (includeProps) {
            console.log(
              `mlb-odds: requesting props for ${gamesFetched} game(s) in parallel`
            );
            propResults = await Promise.all(
              events.map((event) => fetchEventProps(apiKey, event.id))
            );

            const made = propResults.length;
            const succeeded = propResults.filter((r) => r?.ok).length;
            const withProps = propResults.filter(
              (r) => (r?.bookmakers?.length ?? 0) > 0
            ).length;
            console.log(
              `mlb-odds: prop requests made=${made} succeeded=${succeeded} ` +
                `failed=${made - succeeded} gamesWithProps=${withProps}`
            );
          } else {
            console.log("mlb-odds: props disabled for this request; skipping per-event calls");
          }

          const enriched = events.map((event, i) => ({
            id: event.id,
            sport_key: event.sport_key,
            sport_title: event.sport_title,
            commence_time: event.commence_time,
            home_team: event.home_team,
            away_team: event.away_team,
            game_odds: filterBooks(event.bookmakers),
            player_props: includeProps ? propResults[i]?.bookmakers ?? [] : [],
          }));

          const diagnostics = {
            gamesFetched,
            propRequestsMade: includeProps ? propResults.length : 0,
            propRequestsSucceeded: includeProps
              ? propResults.filter((r) => r?.ok).length
              : 0,
            propRequestsFailed: includeProps
              ? propResults.filter((r) => r && !r.ok).length
              : 0,
            gamesWithProps: includeProps
              ? propResults.filter((r) => (r?.bookmakers?.length ?? 0) > 0).length
              : 0,
          };

          return jsonResponse(
            successBody(enriched, "live", { includeProps, diagnostics }),
            200
          );
        }
        // Live API returned no games (e.g. no slate today). Fall through to the
        // database in case it holds something, otherwise report an empty slate.
      } else {
        const detail = await response.text().catch(() => "");
        const quota = isQuotaError(response.status, detail);
        console.error(
          `mlb-odds: game request failed: status ${response.status} ${detail}`
        );

        const fallback = await buildFromDatabase(includeProps);
        if (fallback) {
          console.log(
            `mlb-odds: serving ${fallback.length} game(s) from database fallback`
          );
          return jsonResponse(
            successBody(fallback, "cache", {
              includeProps,
              note: quota
                ? "Live odds quota exhausted; served most recent stored odds."
                : `Live odds unavailable (status ${response.status}); served most recent stored odds.`,
            }),
            200
          );
        }

        return jsonResponse(
          {
            error: quota
              ? "the-odds-api usage quota has been reached and no stored odds are available."
              : `the-odds-api request failed with status ${response.status}.`,
            status: response.status,
          },
          quota ? 429 : 502
        );
      }
    } catch (err) {
      console.error("mlb-odds: error fetching game odds from the-odds-api:", err);
      const fallback = await buildFromDatabase(includeProps);
      if (fallback) {
        console.log(
          `mlb-odds: serving ${fallback.length} game(s) from database fallback`
        );
        return jsonResponse(
          successBody(fallback, "cache", {
            includeProps,
            note: "Live odds unreachable; served most recent stored odds.",
          }),
          200
        );
      }
      return jsonResponse(
        { error: "Failed to reach the-odds-api.com for MLB odds." },
        502
      );
    }
  }

  // 2. No API key, or the live slate was empty: serve stored odds if present.
  const fallback = await buildFromDatabase(includeProps);
  if (fallback) {
    console.log(
      `mlb-odds: serving ${fallback.length} game(s) from database (no live data)`
    );
    return jsonResponse(
      successBody(fallback, "cache", {
        includeProps,
        note: apiKey ? undefined : "API key not configured; served stored odds.",
      }),
      200
    );
  }

  // 3. Nothing live and nothing stored.
  if (!apiKey) {
    return jsonResponse(
      {
        error:
          "Missing API key. Set the ODDS_API_KEY environment variable to a the-odds-api.com key.",
      },
      500
    );
  }

  return jsonResponse(successBody([], "live", { includeProps }), 200);
};

export const config: Config = {
  path: "/api/mlb-odds",
};
