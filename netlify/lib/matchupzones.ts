// ---------------------------------------------------------------------------
// Per-batter / per-pitcher zone HR-rate client — Baseball Savant Statcast.
//
// This powers the "Per Batter" view of the zone-map dashboard. It reads the
// free, public Statcast pitch-level search CSV (the same feed pybaseball's
// `statcast_batter` / `statcast_pitcher` helpers read) and aggregates it into a
// 3x3 strike-zone grid of home-run rate per 100 pitches, for a specific
// batter–pitcher matchup.
//
//   GET https://baseballsavant.mlb.com/statcast_search/csv
//         ?all=true&type=details&player_type=batter
//         &batters_lookup[]=<id>&hfSea=2025|2026|&hfGT=R|
//
// Because the matchup is contextualised by handedness, the two heatmaps it
// produces are genuinely different and each carries a usable sample size:
//   * Batter map  — the batter's pitches seen, filtered to pitchers who throw
//                   with this pitcher's hand → where THIS batter does damage.
//   * Pitcher map — the pitcher's pitches thrown, filtered to batters who stand
//                   on this batter's side → where THIS pitcher is vulnerable.
//
// Statcast's `zone` field is 1–14: zones 1–9 are the 3x3 strike-zone grid
// (1-2-3 top, 4-5-6 middle, 7-8-9 bottom), 11–14 the outside quadrants. Only
// 1–9 are mapped into the grid here.
// ---------------------------------------------------------------------------

import { SAVANT_BASE, currentSeasonYear } from "./config.js";
import { parseCsv } from "./statcast.js";

const ATTRIBUTION =
  "Data from Baseball Savant / MLB Statcast (https://baseballsavant.mlb.com)";

export type Hand = "L" | "R";

/** Aggregated home-run stats for one of the nine strike-zone cells. */
export interface ZoneCell {
  /** Statcast zone id, 1–9. */
  zone: number;
  /** Pitches thrown into this zone across the filtered sample. */
  pitches: number;
  /** Home runs whose final pitch landed in this zone. */
  hr: number;
  /** Home runs per 100 pitches (0 when no pitches). */
  hrPer100: number;
}

/** One side (batter or pitcher) of the matchup, summarised by zone. */
export interface SideZones {
  id: number;
  name: string;
  /** Batter's stance / pitcher's throwing hand. */
  hand: string;
  /** The opposing handedness this side was filtered against. */
  vs: Hand;
  /** Pitches in the filtered sample that fell in zones 1–9. */
  totalPitches: number;
  /** Nine cells, ordered by zone 1→9. */
  zones: ZoneCell[];
}

/** The document returned by /api/matchup-zones. */
export interface MatchupZonesPayload {
  generatedAt: string;
  seasons: number[];
  source: "live" | "cache";
  /** Pitches in the batter's sample thrown by THIS exact pitcher (head-to-head). */
  headToHeadPitches: number;
  batter: SideZones;
  pitcher: SideZones;
  attribution: string;
}

export class MatchupZonesError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "MatchupZonesError";
    this.status = status;
  }
}

/** Default seasons to aggregate: the current season plus the prior one. */
export function defaultSeasons(now: Date = new Date()): number[] {
  const cur = currentSeasonYear(now);
  return [cur - 1, cur];
}

/** Empty 9-cell grid, ready to be filled. */
function emptyZones(): ZoneCell[] {
  return Array.from({ length: 9 }, (_, i) => ({
    zone: i + 1,
    pitches: 0,
    hr: 0,
    hrPer100: 0,
  }));
}

/**
 * Fetch the raw Statcast pitch-level CSV for one player across the given
 * seasons. `playerType` selects which lookup parameter to use. Throws on a
 * non-OK response so callers can fall back to cache.
 */
async function fetchPlayerCsv(
  playerType: "batter" | "pitcher",
  playerId: number,
  seasons: number[]
): Promise<string> {
  const lookup = playerType === "batter" ? "batters_lookup" : "pitchers_lookup";
  // hfSea is a pipe-separated list of seasons with a trailing pipe.
  const hfSea = seasons.map((s) => `${s}|`).join("");
  const url =
    `${SAVANT_BASE}/statcast_search/csv` +
    `?all=true&type=details&player_type=${playerType}` +
    `&${lookup}%5B%5D=${playerId}` +
    `&hfSea=${encodeURIComponent(hfSea)}` +
    `&hfGT=R%7C`;

  const res = await fetch(url, { headers: { Accept: "text/csv,*/*" } });
  if (!res.ok) {
    throw new MatchupZonesError(
      `Savant ${playerType} search failed (status ${res.status})`,
      res.status
    );
  }
  return res.text();
}

/** Column indexes we read out of the Statcast search CSV. */
function columnIndexes(header: string[]) {
  const idx = (name: string) => header.indexOf(name);
  return {
    zone: idx("zone"),
    events: idx("events"),
    stand: idx("stand"),
    pThrows: idx("p_throws"),
    pitcher: idx("pitcher"),
    batter: idx("batter"),
  };
}

/**
 * Aggregate a player's pitch-level CSV into a 3x3 zone grid, keeping only the
 * rows whose opposing-handedness column matches `vsHand`.
 *
 *   playerType "batter"  → keep rows where p_throws === vsHand
 *   playerType "pitcher" → keep rows where stand     === vsHand
 *
 * Returns the nine cells plus the total pitches counted, and — for batters —
 * the number of pitches in the sample thrown by `opponentId` (head-to-head).
 */
function aggregate(
  csv: string,
  playerType: "batter" | "pitcher",
  vsHand: Hand,
  opponentId: number
): { zones: ZoneCell[]; total: number; headToHead: number } {
  const table = parseCsv(csv);
  const zones = emptyZones();
  if (table.length < 2) return { zones, total: 0, headToHead: 0 };

  const col = columnIndexes(table[0].map((h) => h.trim()));
  const handCol = playerType === "batter" ? col.pThrows : col.stand;
  const oppCol = playerType === "batter" ? col.pitcher : col.batter;

  let total = 0;
  let headToHead = 0;

  for (let r = 1; r < table.length; r++) {
    const row = table[r];
    if (row.length <= col.zone) continue;

    if (handCol < 0 || row[handCol] !== vsHand) continue;

    const z = Number(row[col.zone]);
    if (!Number.isInteger(z) || z < 1 || z > 9) continue;

    const cell = zones[z - 1];
    cell.pitches++;
    total++;

    if (col.events >= 0 && row[col.events] === "home_run") cell.hr++;
    if (oppCol >= 0 && Number(row[oppCol]) === opponentId) headToHead++;
  }

  for (const c of zones) {
    c.hrPer100 = c.pitches > 0 ? (c.hr / c.pitches) * 100 : 0;
  }

  return { zones, total, headToHead };
}

/** A switch hitter ("S") bats opposite the pitcher's hand. */
function effectiveBatSide(batSide: string, pitchHand: Hand): Hand {
  const s = (batSide || "").toUpperCase();
  if (s === "L" || s === "R") return s;
  return pitchHand === "L" ? "R" : "L"; // "S" or unknown → platoon advantage
}

/** Look up a player's name and handedness from the MLB Stats API. */
async function resolvePerson(
  playerId: number
): Promise<{ name: string; bat: string; pitch: Hand }> {
  try {
    const res = await fetch(
      `https://statsapi.mlb.com/api/v1/people/${playerId}`
    );
    const data = await res.json();
    const p = data?.people?.[0] || {};
    return {
      name: p.fullName || `#${playerId}`,
      bat: p.batSide?.code || "R",
      pitch: (p.pitchHand?.code as Hand) || "R",
    };
  } catch {
    return { name: `#${playerId}`, bat: "R", pitch: "R" };
  }
}

export interface BuildOptions {
  batterId: number;
  pitcherId: number;
  /** Optional hints to skip the Stats-API lookup. */
  batterName?: string;
  pitcherName?: string;
  batSide?: string;
  pitchHand?: Hand;
  seasons?: number[];
}

/**
 * Build the full matchup payload: fetch both players' pitch-level data in
 * parallel and aggregate each into a handedness-contextualised zone grid.
 */
export async function buildMatchupZones(
  opts: BuildOptions
): Promise<MatchupZonesPayload> {
  const seasons = opts.seasons?.length ? opts.seasons : defaultSeasons();

  // Resolve any missing names / handedness from the Stats API.
  const needBatter = !opts.batterName || !opts.batSide;
  const needPitcher = !opts.pitcherName || !opts.pitchHand;
  const [batterInfo, pitcherInfo] = await Promise.all([
    needBatter ? resolvePerson(opts.batterId) : Promise.resolve(null),
    needPitcher ? resolvePerson(opts.pitcherId) : Promise.resolve(null),
  ]);

  const batterName = opts.batterName || batterInfo?.name || `#${opts.batterId}`;
  const pitcherName =
    opts.pitcherName || pitcherInfo?.name || `#${opts.pitcherId}`;
  const batSide = (opts.batSide || batterInfo?.bat || "R").toUpperCase();
  const pitchHand = ((opts.pitchHand || pitcherInfo?.pitch || "R").toUpperCase()
    .charAt(0) === "L"
    ? "L"
    : "R") as Hand;

  // The batter map filters by the pitcher's hand; the pitcher map filters by
  // the side this batter would actually stand on against that hand.
  const stand = effectiveBatSide(batSide, pitchHand);

  const [batterCsv, pitcherCsv] = await Promise.all([
    fetchPlayerCsv("batter", opts.batterId, seasons),
    fetchPlayerCsv("pitcher", opts.pitcherId, seasons),
  ]);

  const batterAgg = aggregate(batterCsv, "batter", pitchHand, opts.pitcherId);
  const pitcherAgg = aggregate(pitcherCsv, "pitcher", stand, opts.batterId);

  return {
    generatedAt: new Date().toISOString(),
    seasons,
    source: "live",
    headToHeadPitches: batterAgg.headToHead,
    batter: {
      id: opts.batterId,
      name: batterName,
      hand: batSide,
      vs: pitchHand,
      totalPitches: batterAgg.total,
      zones: batterAgg.zones,
    },
    pitcher: {
      id: opts.pitcherId,
      name: pitcherName,
      hand: pitchHand,
      vs: stand,
      totalPitches: pitcherAgg.total,
      zones: pitcherAgg.zones,
    },
    attribution: ATTRIBUTION,
  };
}
