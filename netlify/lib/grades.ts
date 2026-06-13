// ---------------------------------------------------------------------------
// Grade settlement: turn graded props into a real, settled track record.
//
// The dashboard flags some props with a "value" (VAL) grade. To show users how
// often that grade actually cashes, we need real outcomes — never fabricated.
// This module:
//
//   1. Re-derives the value grade server-side from the SAME stored odds the UI
//      grades from (gradeEventProps), so the recorded grade matches what a user
//      saw on the board.
//   2. Resolves the finished MLB game for an odds row via the public MLB Stats
//      API schedule (resolveFinalGame), then reads the final box score.
//   3. Settles each graded prop against the box score (settleGradedProp): did
//      the Over/Yes side that carried the grade actually clear its line?
//
// Everything here is grounded in real MLB Stats API results. If a game can't be
// confidently matched or isn't final yet, the prop stays `pending` rather than
// being guessed.
// ---------------------------------------------------------------------------

// The five prop markets the board grades. Mirrors MARKETS in config.ts plus the
// alternate HR market the books publish the "to hit a HR" price under.
const HR_MARKETS = new Set(["batter_home_runs", "batter_home_runs_alternate"]);
const LINE_MARKETS = new Set([
  "batter_total_bases",
  "batter_hits_runs_rbis",
  "pitcher_strikeouts",
  "pitcher_outs",
]);

export interface GradedProp {
  resultKey: string;
  eventId: string;
  playerName: string;
  /** Canonical market key used for settlement (alternate HR folds into batter_home_runs). */
  market: string;
  /** The graded side. The value grade is always the Over/Yes side. */
  side: "over";
  /** Posted point line; HR is a fixed 0.5 (to-hit-a-HR). */
  line: number;
  /** Grade tag. Currently only the value grade is tracked. */
  grade: "value";
  bestOdds: number | null;
}

export interface SettledOutcome {
  status: "hit" | "miss" | "push";
  actualValue: number;
}

// ── Name normalization ────────────────────────────────────────────────────
// Odds API descriptions and MLB box-score names are both "First Last" but can
// differ in accents, suffixes and punctuation. Normalize to a comparable form.
function normalizeName(name: string): string {
  return (name || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "") // strip accents
    .toLowerCase()
    .replace(/[.,'']/g, "")
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function namesMatch(a: string, b: string): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Fall back to last name + first initial, which disambiguates all but
  // same-team same-initial twins and avoids missing accent/suffix variants.
  const pa = na.split(" ");
  const pb = nb.split(" ");
  if (pa.length < 2 || pb.length < 2) return false;
  const lastA = pa[pa.length - 1];
  const lastB = pb[pb.length - 1];
  return lastA === lastB && pa[0][0] === pb[0][0];
}

// ── Grading (mirror of the frontend value-grade logic) ─────────────────────
// Builds, from one event's stored propsData, the list of value-graded Over/Yes
// props. Only props that earn the VAL badge are returned — those are the picks
// whose track record we publish.
export function gradeEventProps(eventId: string, propsData: any): GradedProp[] {
  const books: any[] = propsData?.bookmakers;
  if (!Array.isArray(books) || books.length === 0) return [];

  // Collect Over/Yes prices keyed by player|market|point.
  type Slot = { player: string; market: string; line: number; prices: number[] };
  const slots = new Map<string, Slot>();

  for (const book of books) {
    for (const market of book?.markets || []) {
      const key: string = market?.key;
      if (!key) continue;
      const isHr = HR_MARKETS.has(key);
      const isLine = LINE_MARKETS.has(key);
      if (!isHr && !isLine) continue;

      for (const o of market?.outcomes || []) {
        const player = o?.description || "";
        if (!player) continue;
        const name = o?.name;
        // The value grade lives on the Over (or HR "Yes") side only.
        const isOverSide = name === "Over" || name === "Yes";
        if (!isOverSide) continue;
        if (typeof o?.price !== "number") continue;

        let line: number;
        let canonical: string;
        if (isHr) {
          // Single "to hit a HR" price; pin the 0.5 line and ignore 1.5+ alts.
          if (o.point != null && o.point !== 0.5) continue;
          line = 0.5;
          canonical = "batter_home_runs";
        } else {
          if (o.point == null) continue;
          line = o.point;
          canonical = key;
        }

        const slotKey = `${normalizeName(player)}|${canonical}|${line}`;
        let slot = slots.get(slotKey);
        if (!slot) {
          slot = { player, market: canonical, line, prices: [] };
          slots.set(slotKey, slot);
        }
        slot.prices.push(o.price);
      }
    }
  }

  const graded: GradedProp[] = [];
  for (const slot of slots.values()) {
    if (slot.prices.length === 0) continue;
    const bestOdds = Math.max(...slot.prices);

    // Value test, matching the frontend exactly:
    //  - HR (single price): best must beat the posted average by +15 or more.
    //  - Over/Under line markets: best Over price must be -105 or better.
    let isValue: boolean;
    if (slot.market === "batter_home_runs") {
      const trueOdds = Math.round(
        slot.prices.reduce((a, b) => a + b, 0) / slot.prices.length
      );
      isValue = bestOdds >= trueOdds + 15;
    } else {
      isValue = bestOdds >= -105;
    }
    if (!isValue) continue;

    graded.push({
      resultKey: `${eventId}|${normalizeName(slot.player)}|${slot.market}|${slot.line}|over`,
      eventId,
      playerName: slot.player,
      market: slot.market,
      side: "over",
      line: slot.line,
      grade: "value",
      bestOdds,
    });
  }
  return graded;
}

// ── Game resolution + box score ────────────────────────────────────────────
// Format a Date as the official MLB game date (YYYY-MM-DD) in US Eastern, which
// is how the schedule endpoint keys games.
function easternDateString(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export interface FinalGame {
  gamePk: number;
  boxscore: any;
}

// Find the final MLB game matching an odds row and return its box score, or null
// if the game can't be confidently matched or isn't final yet.
export async function resolveFinalGame(
  homeTeam: string,
  awayTeam: string,
  commenceTime: Date | null
): Promise<FinalGame | null> {
  if (!commenceTime) return null;
  const date = easternDateString(commenceTime);

  let games: any[] = [];
  try {
    const res = await fetch(
      `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    games = data?.dates?.flatMap((dd: any) => dd?.games || []) || [];
  } catch (err) {
    console.error("grades: schedule fetch failed:", err);
    return null;
  }

  const match = games.find((g: any) => {
    const h = g?.teams?.home?.team?.name || "";
    const a = g?.teams?.away?.team?.name || "";
    return (
      normalizeName(h) === normalizeName(homeTeam) &&
      normalizeName(a) === normalizeName(awayTeam)
    );
  });
  if (!match) return null;

  // Only settle final games; live/postponed games stay pending.
  const state = match?.status?.abstractGameState;
  if (state !== "Final") return null;

  const gamePk = match.gamePk;
  try {
    const res = await fetch(
      `https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`
    );
    if (!res.ok) return null;
    const boxscore = await res.json();
    return { gamePk, boxscore };
  } catch (err) {
    console.error(`grades: boxscore fetch failed for ${gamePk}:`, err);
    return null;
  }
}

// Pull a player's stat block out of a box score by name match.
function findPlayerStats(
  boxscore: any,
  playerName: string
): { batting?: any; pitching?: any } | null {
  for (const sideKey of ["home", "away"]) {
    const players = boxscore?.teams?.[sideKey]?.players;
    if (!players) continue;
    for (const pid of Object.keys(players)) {
      const p = players[pid];
      const full = p?.person?.fullName || "";
      if (namesMatch(full, playerName)) {
        return { batting: p?.stats?.batting, pitching: p?.stats?.pitching };
      }
    }
  }
  return null;
}

// Compute the real stat value for a market from a player's box-score line.
// Returns null when the player did not appear (and thus can't be settled).
function actualForMarket(
  stats: { batting?: any; pitching?: any },
  market: string
): number | null {
  const b = stats.batting;
  const p = stats.pitching;
  switch (market) {
    case "batter_home_runs":
      if (!b) return null;
      return num(b.homeRuns);
    case "batter_total_bases": {
      if (!b) return null;
      const hits = num(b.hits);
      const doubles = num(b.doubles);
      const triples = num(b.triples);
      const hr = num(b.homeRuns);
      const singles = hits - doubles - triples - hr;
      return singles + 2 * doubles + 3 * triples + 4 * hr;
    }
    case "batter_hits_runs_rbis":
      if (!b) return null;
      return num(b.hits) + num(b.runs) + num(b.rbi);
    case "pitcher_strikeouts":
      if (!p) return null;
      return num(p.strikeOuts);
    case "pitcher_outs": {
      if (!p) return null;
      // Prefer the explicit out count; fall back to innings pitched ("6.2").
      if (p.outs != null) return num(p.outs);
      const ip = String(p.inningsPitched ?? "0");
      const [whole, frac] = ip.split(".");
      return parseInt(whole || "0", 10) * 3 + parseInt(frac || "0", 10);
    }
    default:
      return null;
  }
}

function num(v: any): number {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

// Settle one graded prop against a final box score. Returns null when the player
// can't be found (prop stays pending and is retried on a later run).
export function settleGradedProp(
  prop: GradedProp,
  boxscore: any
): SettledOutcome | null {
  const stats = findPlayerStats(boxscore, prop.playerName);
  if (!stats) return null;
  const actual = actualForMarket(stats, prop.market);
  if (actual == null) return null;

  // The graded side is always the Over/Yes side.
  let status: SettledOutcome["status"];
  if (actual > prop.line) status = "hit";
  else if (actual === prop.line) status = "push";
  else status = "miss";

  return { status, actualValue: actual };
}
