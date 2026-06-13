// ---------------------------------------------------------------------------
// Thin client for The Odds API plus the shared payload types.
//
// Two endpoints are used:
//   GET /v4/sports/{sport}/events            -> free, lists upcoming/live games
//   GET /v4/sports/{sport}/events/{id}/odds  -> costs credits, returns props
//
// The /events call is used first to discover game IDs and commence times so we
// only spend credits on the per-event odds calls that actually matter.
// ---------------------------------------------------------------------------

import {
  ODDS_API_BASE,
  SPORT_KEY,
  REGION,
  ODDS_FORMAT,
  MARKETS_PARAM,
  BOOKMAKERS_PARAM,
} from "./config.js";

// --- Raw shapes returned by The Odds API ----------------------------------

export interface ApiOutcome {
  name: string; // "Over" | "Under" (player props)
  price: number; // American odds
  point?: number; // the line, e.g. 0.5, 1.5
  description?: string; // player name for prop markets
}

export interface ApiMarket {
  key: string;
  last_update?: string;
  outcomes: ApiOutcome[];
}

export interface ApiBookmaker {
  key: string;
  title: string;
  last_update?: string;
  markets: ApiMarket[];
}

export interface ApiEvent {
  id: string;
  sport_key: string;
  sport_title?: string;
  commence_time: string;
  home_team: string;
  away_team: string;
}

export interface ApiEventOdds extends ApiEvent {
  bookmakers?: ApiBookmaker[];
}

/** Result of a credit-consuming fetch, carrying the quota headers. */
export interface OddsFetchMeta {
  /** x-requests-remaining header value, if present. */
  requestsRemaining: number | null;
  /** x-requests-used header value, if present. */
  requestsUsed: number | null;
  /** x-requests-last header value (credits spent on this call), if present. */
  requestsLast: number | null;
}

function parseMeta(res: Response): OddsFetchMeta {
  const num = (h: string): number | null => {
    const v = res.headers.get(h);
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    requestsRemaining: num("x-requests-remaining"),
    requestsUsed: num("x-requests-used"),
    requestsLast: num("x-requests-last"),
  };
}

/**
 * List upcoming and in-progress events. This endpoint does NOT consume API
 * credits, so it is safe to call on every scheduled run, in or out of window.
 */
export async function fetchEvents(
  apiKey: string
): Promise<{ events: ApiEvent[]; meta: OddsFetchMeta }> {
  const url =
    `${ODDS_API_BASE}/sports/${SPORT_KEY}/events` +
    `?apiKey=${apiKey}&dateFormat=iso`;

  const res = await fetch(url);
  const meta = parseMeta(res);

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new OddsApiError(
      `events request failed (status ${res.status})`,
      res.status,
      detail
    );
  }

  const events = (await res.json()) as ApiEvent[];
  return { events: Array.isArray(events) ? events : [], meta };
}

/**
 * Fetch player props for a single event. Scoped to the configured markets and
 * books. Costs credits proportional to the number of markets requested.
 *
 * Always resolves (never throws) so one failing game cannot abort a slate.
 */
export async function fetchEventOdds(
  apiKey: string,
  eventId: string
): Promise<{ data: ApiEventOdds | null; meta: OddsFetchMeta; error?: string }> {
  const url =
    `${ODDS_API_BASE}/sports/${SPORT_KEY}/events/${eventId}/odds` +
    `?apiKey=${apiKey}&regions=${REGION}&markets=${MARKETS_PARAM}` +
    `&bookmakers=${BOOKMAKERS_PARAM}&oddsFormat=${ODDS_FORMAT}&dateFormat=iso`;

  try {
    const res = await fetch(url);
    const meta = parseMeta(res);
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn(
        `mlb-props: event-odds for ${eventId} failed (status ${res.status})` +
          (detail ? `: ${detail}` : "")
      );
      return { data: null, meta, error: detail || `status ${res.status}` };
    }
    const data = (await res.json()) as ApiEventOdds;
    return { data, meta };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`mlb-props: error fetching event-odds for ${eventId}:`, message);
    return {
      data: null,
      meta: { requestsRemaining: null, requestsUsed: null, requestsLast: null },
      error: message,
    };
  }
}

export class OddsApiError extends Error {
  status: number;
  detail: string;
  constructor(message: string, status: number, detail: string) {
    super(message);
    this.name = "OddsApiError";
    this.status = status;
    this.detail = detail;
  }

  /** The Odds API reports an exhausted plan as 401 OUT_OF_USAGE_CREDITS or 429. */
  get isQuota(): boolean {
    return (
      this.status === 429 ||
      (this.status === 401 && this.detail.includes("OUT_OF_USAGE_CREDITS"))
    );
  }
}
