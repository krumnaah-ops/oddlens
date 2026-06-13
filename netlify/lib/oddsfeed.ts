// ---------------------------------------------------------------------------
// Shared odds + player-props feed for the database-backed /api/odds endpoint.
//
// This implements the correct two-step flow against The Odds API:
//
//   1. GET /v4/sports/baseball_mlb/events            (free, no credits)
//        -> discover the upcoming/live game IDs and commence times.
//   2. GET /v4/sports/baseball_mlb/events/{id}/odds  (costs credits)
//        -> fetch the game lines AND the player-prop markets for one game.
//
// The bulk /odds endpoint is deliberately NOT used: it cannot return player
// props at all, which is why props never appeared in the dashboard before. The
// per-event odds endpoint is the only endpoint that carries prop markets.
//
// Each per-event response is split into two payloads with the exact shape the
// dashboard expects: `oddsData` (game markets) and `propsData` (prop markets).
// A failure on one game never aborts the others.
// ---------------------------------------------------------------------------

import {
  ODDS_API_BASE,
  SPORT_KEY,
  REGION,
  ODDS_FORMAT,
  BOOKMAKERS_PARAM,
  BOOKMAKER_KEYS,
} from "./config.js";
import { fetchEvents, OddsApiError } from "./oddsApi.js";
import type { ApiEvent, ApiBookmaker } from "./oddsApi.js";
import { db } from "../../db/index.js";
import { odds } from "../../db/schema.js";

/** Featured game-line markets rendered as "odds" in the dashboard. */
export const GAME_MARKETS = ["h2h", "spreads", "totals"];

/** MLB player-prop markets rendered in the dashboard's props views. */
export const PROP_MARKETS = [
  "batter_home_runs",
  // The major books (DraftKings, FanDuel, BetMGM, Bovada) do NOT publish their
  // home-run props under `batter_home_runs`; The Odds API only exposes them
  // under `batter_home_runs_alternate`. Without this key those books return
  // every other prop but no HR line, which is why the HR tab appeared on only
  // a couple of books. Caesars/Novig/BetOnline use the standard key, so both
  // are fetched and the frontend merges them into a single HR price per book.
  "batter_home_runs_alternate",
  "batter_total_bases",
  "batter_hits_runs_rbis",
  "pitcher_strikeouts",
  "pitcher_outs",
];

const ALL_MARKETS_PARAM = [...GAME_MARKETS, ...PROP_MARKETS].join(",");
const GAME_SET = new Set(GAME_MARKETS);
const PROP_SET = new Set(PROP_MARKETS);

// Only ever store/serve the books configured in config.ts. This is the single
// source of truth for "which books we show", shared with the bookmakers query
// parameter below so the API request and the post-filter can never drift.
const ALLOWED_BOOKS = new Set(BOOKMAKER_KEYS);

// Only spend prop credits on the current slate. /events can list games several
// days out whose props aren't posted yet; fetching them just wastes quota.
const LOOKAHEAD_HOURS = 30; // covers today + tonight's late games
const LIVE_GRACE_HOURS = 4; // a game is still "live" up to ~4h after first pitch

/** Keep games that are live now or starting within the lookahead window. */
function inCurrentSlate(ev: ApiEvent, now: number): boolean {
  const start = new Date(ev.commence_time).getTime();
  if (!Number.isFinite(start)) return true; // keep if time is unparseable
  return (
    start <= now + LOOKAHEAD_HOURS * 3600_000 &&
    start >= now - LIVE_GRACE_HOURS * 3600_000
  );
}

/** A row ready to be upserted into the `odds` table / served from /api/odds. */
export interface OddsRow {
  eventId: string;
  sportKey: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: Date | null;
  oddsData: unknown;
  propsData: unknown;
  updatedAt: Date;
}

/** Keep only the bookmakers/markets matching `keep`, dropping empty books. */
function booksFor(
  bookmakers: ApiBookmaker[] | undefined,
  keep: Set<string>
): ApiBookmaker[] {
  if (!Array.isArray(bookmakers)) return [];
  return bookmakers
    // Restrict to the configured books. The API request below already scopes
    // the response with `bookmakers=`, but filtering again here guarantees that
    // an unexpected book in the payload can never leak into stored/served data.
    .filter((b) => b && typeof b.key === "string" && ALLOWED_BOOKS.has(b.key))
    .map((b) => ({
      ...b,
      markets: (b.markets || []).filter((m) => keep.has(m.key)),
    }))
    .filter((b) => b.markets.length > 0);
}

/**
 * Re-scope a stored/served row to exactly the books shown on the site and the
 * configured markets. Storage is an upsert that never deletes, so a row written
 * by an older, wider pipeline can still carry sportsbooks we no longer display
 * (or markets we no longer fetch). Applying the same `booksFor` filter we use on
 * write — keyed off the single ALLOWED_BOOKS / GAME_SET / PROP_SET source of
 * truth — guarantees /api/odds can never serve a book the dashboard doesn't show,
 * regardless of what is in the database.
 */
export function scopeRowToSite<T extends { oddsData?: unknown; propsData?: unknown }>(
  row: T
): T {
  const od = row.oddsData as { bookmakers?: ApiBookmaker[] } | null | undefined;
  const pd = row.propsData as { bookmakers?: ApiBookmaker[] } | null | undefined;
  return {
    ...row,
    oddsData:
      od && typeof od === "object"
        ? { ...od, bookmakers: booksFor(od.bookmakers, GAME_SET) }
        : od,
    propsData:
      pd && typeof pd === "object"
        ? { ...pd, bookmakers: booksFor(pd.bookmakers, PROP_SET) }
        : pd,
  };
}

/**
 * True once a game has finished (started more than LIVE_GRACE_HOURS ago). Used to
 * drop stale rows for completed games that linger in storage because the upsert
 * write path only ever inserts/updates the current slate and never deletes.
 */
export function isFinishedGame(
  commenceTime: Date | string | null | undefined,
  now: number = Date.now()
): boolean {
  if (!commenceTime) return false;
  const t = new Date(commenceTime).getTime();
  if (!Number.isFinite(t)) return false;
  return t < now - LIVE_GRACE_HOURS * 3600_000;
}

/** True if, after scoping, a row carries no game lines and no props at all. */
function rowHasNoBooks(row: {
  oddsData?: unknown;
  propsData?: unknown;
}): boolean {
  const od = (row.oddsData as any)?.bookmakers?.length ?? 0;
  const pd = (row.propsData as any)?.bookmakers?.length ?? 0;
  return od === 0 && pd === 0;
}

/**
 * Normalise a list of stored/served rows for the public API: scope every row to
 * the site's books + configured markets, drop games that have already finished,
 * and drop rows left empty once off-config books are removed (legacy junk rows).
 */
export function scopeRowsForSite<T extends {
  oddsData?: unknown;
  propsData?: unknown;
  commenceTime?: Date | string | null;
}>(rows: T[], now: number = Date.now()): T[] {
  return rows
    .filter((r) => !isFinishedGame(r.commenceTime, now))
    .map((r) => scopeRowToSite(r))
    .filter((r) => !rowHasNoBooks(r));
}

/**
 * Fetch game lines + player props for a single event. Always resolves: a failed
 * game returns null and is logged, so one bad game can't sink the slate.
 */
async function fetchEventRow(
  apiKey: string,
  ev: ApiEvent
): Promise<OddsRow | null> {
  const label = `${ev.away_team} @ ${ev.home_team}`;
  const url =
    `${ODDS_API_BASE}/sports/${SPORT_KEY}/events/${ev.id}/odds` +
    `?apiKey=${apiKey}&regions=${REGION}&markets=${ALL_MARKETS_PARAM}` +
    `&bookmakers=${BOOKMAKERS_PARAM}` +
    `&oddsFormat=${ODDS_FORMAT}&dateFormat=iso`;

  try {
    const res = await fetch(url);
    const remaining = res.headers.get("x-requests-remaining");
    const used = res.headers.get("x-requests-last");

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn(
        `odds-feed: per-event odds for ${label} (${ev.id}) failed: ` +
          `status ${res.status}${detail ? ` ${detail}` : ""}`
      );
      return null;
    }

    const data = (await res.json()) as ApiEvent & {
      sport_title?: string;
      bookmakers?: ApiBookmaker[];
    };

    const gameBooks = booksFor(data.bookmakers, GAME_SET);
    const propBooks = booksFor(data.bookmakers, PROP_SET);

    console.log(
      `odds-feed: ${label} -> ${gameBooks.length} book(s) with game lines, ` +
        `${propBooks.length} book(s) with props ` +
        `(credits remaining=${remaining ?? "n/a"}, used=${used ?? "n/a"})`
    );

    const base = {
      id: ev.id,
      sport_key: ev.sport_key,
      sport_title: data.sport_title ?? "MLB",
      commence_time: ev.commence_time,
      home_team: ev.home_team,
      away_team: ev.away_team,
    };

    return {
      eventId: ev.id,
      sportKey: ev.sport_key,
      homeTeam: ev.home_team,
      awayTeam: ev.away_team,
      commenceTime: ev.commence_time ? new Date(ev.commence_time) : null,
      oddsData: { ...base, bookmakers: gameBooks },
      propsData: { ...base, bookmakers: propBooks },
      updatedAt: new Date(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`odds-feed: error fetching per-event odds for ${label}:`, message);
    return null;
  }
}

/**
 * Run the full pipeline: discover events via the free /events endpoint, then
 * fetch game lines + player props per event in parallel. Returns the rows that
 * succeeded. Returns [] (and logs) on quota exhaustion or when there is no
 * slate, so callers can degrade gracefully rather than throw.
 */
export async function buildOddsRows(apiKey: string): Promise<OddsRow[]> {
  // 1. Free events discovery.
  let events: ApiEvent[];
  try {
    const result = await fetchEvents(apiKey);
    events = result.events;
    console.log(
      `odds-feed: /events returned ${events.length} upcoming MLB game(s) ` +
        `(credits remaining=${result.meta.requestsRemaining ?? "n/a"})`
    );
  } catch (err) {
    if (err instanceof OddsApiError && err.isQuota) {
      console.error("odds-feed: API quota exhausted on /events; skipping fetch.");
    } else {
      console.error("odds-feed: /events request failed:", err);
    }
    return [];
  }

  if (events.length === 0) {
    console.warn("odds-feed: no upcoming MLB events returned by /events.");
    return [];
  }

  // Focus credit spend on the current slate (live + starting soon).
  const slate = events.filter((ev) => inCurrentSlate(ev, Date.now()));
  console.log(
    `odds-feed: ${slate.length}/${events.length} event(s) are in the current ` +
      `slate (live or within ${LOOKAHEAD_HOURS}h); fetching props for those.`
  );
  if (slate.length === 0) return [];

  // 2. Per-event game lines + props, in parallel; failures isolated to one game.
  const rows = await Promise.all(slate.map((ev) => fetchEventRow(apiKey, ev)));
  const ok = rows.filter((r): r is OddsRow => r !== null);

  const withProps = ok.filter(
    (r) => ((r.propsData as any)?.bookmakers?.length ?? 0) > 0
  ).length;

  console.log(
    `odds-feed: built ${ok.length}/${slate.length} game row(s); ` +
      `${withProps} game(s) have player props.`
  );

  return ok;
}

/**
 * Upsert built rows into the `odds` table, keyed by eventId. A failure on one
 * row is logged and skipped so the rest still persist. Returns the number of
 * rows saved. This is the single shared write path used by the scheduled writer
 * (fetch-odds), the manual admin trigger (pull-odds) and the on-read live
 * refresh in /api/odds.
 */
export async function persistOddsRows(rows: OddsRow[]): Promise<number> {
  let saved = 0;
  for (const row of rows) {
    try {
      await db
        .insert(odds)
        .values(row)
        .onConflictDoUpdate({
          target: odds.eventId,
          set: {
            sportKey: row.sportKey,
            homeTeam: row.homeTeam,
            awayTeam: row.awayTeam,
            commenceTime: row.commenceTime,
            oddsData: row.oddsData,
            propsData: row.propsData,
            updatedAt: row.updatedAt,
          },
        });
      saved++;
    } catch (err) {
      console.error(`odds-feed: failed to persist ${row.eventId}:`, err);
    }
  }
  return saved;
}
