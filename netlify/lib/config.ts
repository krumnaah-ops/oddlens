// ---------------------------------------------------------------------------
// MLB player-props feature — central configuration.
//
// Everything that you might want to tune lives here: the markets fetched, the
// books queried, the scheduling window and the relevance window. Change a value
// in this file and both the scheduled updater and the public API pick it up.
//
// See MLB_PROPS_README.md for a walkthrough of how to adjust these safely.
// ---------------------------------------------------------------------------

/** The Odds API sport key. */
export const SPORT_KEY = "baseball_mlb";

/** Region passed to The Odds API ("us" covers the books below). */
export const REGION = "us";

/** Odds format requested from The Odds API. */
export const ODDS_FORMAT = "american";

/**
 * The exactly-five player-prop markets we fetch from the per-event odds
 * endpoint. These are the only markets requested, which keeps each call cheap.
 *
 * Add/remove markets here and the rest of the pipeline adapts automatically.
 * `type` controls whether a market is rendered in the "Batter props" or
 * "Pitcher props" section of the UI.
 */
export const MARKETS: ReadonlyArray<{
  key: string;
  label: string;
  type: "batter" | "pitcher";
}> = [
  { key: "batter_home_runs", label: "Home Runs", type: "batter" },
  { key: "batter_total_bases", label: "Total Bases", type: "batter" },
  { key: "batter_hits_runs_rbis", label: "Hits + Runs + RBIs", type: "batter" },
  { key: "pitcher_strikeouts", label: "Strikeouts", type: "pitcher" },
  { key: "pitcher_outs", label: "Outs Recorded", type: "pitcher" },
];

/** Comma-joined market keys, ready to drop into a query string. */
export const MARKET_KEYS = MARKETS.map((m) => m.key);
export const MARKETS_PARAM = MARKET_KEYS.join(",");

/**
 * The exactly-eight bookmakers we request. Scoping the request to these books
 * keeps payloads small and avoids burning quota on books we don't display.
 */
export const BOOKMAKERS: ReadonlyArray<{ key: string; title: string }> = [
  { key: "draftkings", title: "DraftKings" },
  { key: "fanduel", title: "FanDuel" },
  { key: "betmgm", title: "BetMGM" },
  { key: "williamhill_us", title: "Caesars" },
  { key: "bovada", title: "Bovada" },
  { key: "betonlineag", title: "BetOnline.ag" },
  { key: "mybookieag", title: "MyBookie.ag" },
  { key: "novig", title: "Novig" },
];

export const BOOKMAKER_KEYS = BOOKMAKERS.map((b) => b.key);
export const BOOKMAKERS_PARAM = BOOKMAKER_KEYS.join(",");

/** Lookup of book key -> friendly title (falls back to the key). */
export const BOOK_TITLES: Record<string, string> = Object.fromEntries(
  BOOKMAKERS.map((b) => [b.key, b.title])
);

// ---------------------------------------------------------------------------
// Scheduling window
//
// The scheduled function runs every 2 hours (see netlify.toml / the function's
// `config.schedule`). On each run it decides whether it is inside the "active
// daily window" and therefore should spend credits fetching player props, or
// outside it, in which case it only performs a free /events check.
//
// The active window is computed dynamically from the day's game times:
//   start = earliest game commence time  - WINDOW_START_LEAD_MINUTES
//   end   = latest   game commence time  - WINDOW_END_TRAIL_MINUTES
//
// With a typical MLB slate (first pitch ~12:00 CT, last game ~19:00 CT) this
// yields roughly a 10:00 CT - 18:30 CT window. Adjust the leads below to widen
// or narrow it.
// ---------------------------------------------------------------------------

/** Start the active window this many minutes before the earliest game. */
export const WINDOW_START_LEAD_MINUTES = 120; // ~2 hours before first pitch

/** End the active window this many minutes before the latest game. */
export const WINDOW_END_TRAIL_MINUTES = 30; // ~30 minutes before last first-pitch

/**
 * A game is "relevant" (worth spending credits on) when it starts within this
 * many hours, or is already live. Props for games further out are skipped.
 */
export const RELEVANCE_LOOKAHEAD_HOURS = 8;

// ---------------------------------------------------------------------------
// Daily pull window (Central Time)
//
// The scheduled odds pullers (fetch-odds.mts, update-mlb-props.mts) only do
// any work at the discrete pull hours 10am, 12pm, 2pm, 4pm and 6pm, measured in
// the PULL_WINDOW_TZ timezone — i.e. every 2 hours from PULL_WINDOW_START_HOUR
// through PULL_WINDOW_END_HOUR inclusive. At any other hour they no-op without
// hitting The Odds API at all. The timezone is given as an IANA zone so the
// hours track wall-clock Central Time and adjust automatically across
// daylight-saving changes; because of that the functions are scheduled to run
// hourly and this window decides which of those runs actually pulls. The manual
// /pull-odds admin endpoint ignores this window so odds can still be pulled on
// demand ("unless I say otherwise").
// ---------------------------------------------------------------------------

/** IANA timezone used to evaluate the daily pull window. */
export const PULL_WINDOW_TZ = "America/Chicago";

/** First pull hour (inclusive) of the day, e.g. 10 = 10:00am. */
export const PULL_WINDOW_START_HOUR = 10;

/** Last pull hour (inclusive) of the day, e.g. 18 = 6:00pm. */
export const PULL_WINDOW_END_HOUR = 18;

/** Hours between consecutive pulls, e.g. 2 = 10, 12, 14, 16, 18. */
export const PULL_WINDOW_STEP_HOURS = 2;

/**
 * How long after first pitch a game is still considered live/relevant. MLB
 * games rarely exceed ~4 hours.
 */
export const LIVE_GRACE_HOURS = 4;

// ---------------------------------------------------------------------------
// Blob storage
// ---------------------------------------------------------------------------

/** Netlify Blobs store namespace for the cached props payload. */
export const BLOB_STORE = "mlb-props";

/** Key within the store holding the latest combined payload. */
export const BLOB_LATEST_KEY = "latest";

// ---------------------------------------------------------------------------
// The Odds API
// ---------------------------------------------------------------------------

export const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

/** Read the API key from the environment (set globally on the site). */
export function getApiKey(): string | null {
  return process.env.ODDS_API_KEY || null;
}

// ---------------------------------------------------------------------------
// Baseball Savant / Statcast (exit velocity & barrels)
//
// This is the same free, public leaderboard CSV that pybaseball's
// `statcast_batter_exitvelo_barrels` / `statcast_pitcher_exitvelo_barrels`
// helpers read. It requires no API key and does not consume any quota, so —
// unlike The Odds API — the public endpoint can safely fetch it on a cache
// miss. See STATCAST_README.md.
//
//   GET https://baseballsavant.mlb.com/leaderboard/statcast
//         ?type=batter|pitcher&year=<season>&position=&team=&min=<bbe>&csv=true
// ---------------------------------------------------------------------------

export const SAVANT_BASE = "https://baseballsavant.mlb.com";

/** Path to the Statcast exit-velocity & barrels leaderboard. */
export const STATCAST_LEADERBOARD_PATH = "/leaderboard/statcast";

/**
 * Minimum batted-ball events a player needs to appear. "q" means "qualified"
 * (Savant's own qualification threshold); a number sets an explicit minimum.
 */
export const STATCAST_MIN_BBE = "q";

/** Netlify Blobs store namespace + key for the cached Statcast payload. */
export const STATCAST_BLOB_STORE = "mlb-statcast";
export const STATCAST_LATEST_KEY = "latest";

/**
 * The season whose leaderboard to fetch by default. Savant only publishes a
 * season's data once it has started, so before Opening Day (Jan/Feb) we fall
 * back to the previous, completed season.
 */
export function currentSeasonYear(now: Date = new Date()): number {
  const year = now.getUTCFullYear();
  // Months are 0-based: 0 = January, 1 = February.
  return now.getUTCMonth() < 2 ? year - 1 : year;
}
