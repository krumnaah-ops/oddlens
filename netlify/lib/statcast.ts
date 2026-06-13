// ---------------------------------------------------------------------------
// Baseball Savant / Statcast client — exit velocity & barrels leaderboards.
//
// This mirrors pybaseball's `statcast_batter_exitvelo_barrels` and
// `statcast_pitcher_exitvelo_barrels`: it reads the free, public CSV
// leaderboard from Baseball Savant, parses it, and normalizes the columns into
// friendly, typed records. No API key and no quota are involved.
//
//   GET /leaderboard/statcast?type=batter&year=2025&min=q&csv=true
//
// The CSV's first column header is literally `last_name, first_name` (a single
// quoted field that itself contains a comma), so a quote-aware parser is
// required — a naive split on "," mangles every row.
// ---------------------------------------------------------------------------

import {
  SAVANT_BASE,
  STATCAST_LEADERBOARD_PATH,
  STATCAST_MIN_BBE,
  currentSeasonYear,
} from "./config.js";

export type StatcastType = "batter" | "pitcher";

const ATTRIBUTION =
  "Data from Baseball Savant / MLB Statcast (https://baseballsavant.mlb.com)";

/** One row of the exit-velocity & barrels leaderboard, normalized. */
export interface ExitVeloBarrelRecord {
  playerId: number | null;
  /** "First Last" (reformatted from Savant's "Last, First"). */
  player: string;
  /** Batted-ball events (Savant column `attempts`). */
  battedBallEvents: number | null;
  /** Average launch angle, degrees (`avg_hit_angle`). */
  avgLaunchAngle: number | null;
  /** Sweet-spot %, share of BBE with an 8–32° launch angle (`anglesweetspotpercent`). */
  sweetSpotPct: number | null;
  /** Max exit velocity, mph (`max_hit_speed`). */
  maxExitVelocity: number | null;
  /** Average exit velocity, mph (`avg_hit_speed`). */
  avgExitVelocity: number | null;
  /** Average EV of the hardest-hit 50% of batted balls, mph (`ev50`). */
  avgBestExitVelocity: number | null;
  /** Average EV on fly balls & line drives, mph (`fbld`). */
  flyballLinedriveExitVelocity: number | null;
  /** Average EV on ground balls, mph (`gb`). */
  groundballExitVelocity: number | null;
  /** Max hit distance, feet (`max_distance`). */
  maxDistance: number | null;
  /** Average hit distance, feet (`avg_distance`). */
  avgDistance: number | null;
  /** Average home-run distance, feet (`avg_hr_distance`). */
  avgHomeRunDistance: number | null;
  /** Count of batted balls hit 95+ mph (`ev95plus`). */
  hardHitCount: number | null;
  /** Hard-hit %, share of BBE hit 95+ mph (`ev95percent`). */
  hardHitPct: number | null;
  /** Barrel count (`barrels`). */
  barrels: number | null;
  /** Barrels per batted-ball event, % (`brl_percent`). */
  barrelPct: number | null;
  /** Barrels per plate appearance, % (`brl_pa`). */
  barrelsPerPa: number | null;
}

/** The cached document served by /api/statcast and written by the updater. */
export interface StatcastPayload {
  generatedAt: string;
  season: number;
  minBattedBalls: string;
  source: "live" | "cache";
  batters: ExitVeloBarrelRecord[];
  pitchers: ExitVeloBarrelRecord[];
  counts: { batters: number; pitchers: number };
  attribution: string;
}

/** Raised when Savant returns a non-OK response. */
export class StatcastError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "StatcastError";
    this.status = status;
  }
}

// --- CSV parsing -----------------------------------------------------------

/**
 * Minimal RFC-4180-ish CSV parser: handles quoted fields, embedded commas,
 * doubled quotes ("") as an escaped quote, and CRLF/LF line endings. Returns
 * an array of rows, each an array of cell strings. A leading BOM is stripped.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  // Strip a UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++; // skip the escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
    } else if (c === "\r") {
      // ignore; handled by the following \n (or end of input)
    } else {
      field += c;
    }
  }

  // Flush the final field/row if the file does not end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/** Parse a numeric cell, treating blanks and non-numbers as null. */
function num(v: string | undefined): number | null {
  if (v == null) return null;
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Reformat Savant's "Last, First" name into "First Last". */
function formatPlayerName(raw: string | undefined): string {
  const v = (raw ?? "").trim();
  const comma = v.indexOf(",");
  if (comma === -1) return v;
  const last = v.slice(0, comma).trim();
  const first = v.slice(comma + 1).trim();
  return first ? `${first} ${last}` : last;
}

/**
 * Convert the parsed CSV table into normalized records, addressing columns by
 * their header name so the mapping is resilient to column-order changes.
 */
export function parseExitVeloBarrels(csv: string): ExitVeloBarrelRecord[] {
  const table = parseCsv(csv);
  if (table.length < 2) return [];

  const header = table[0].map((h) => h.trim());
  const idx = (name: string) => header.indexOf(name);

  const col = {
    name: idx("last_name, first_name"),
    playerId: idx("player_id"),
    attempts: idx("attempts"),
    avgHitAngle: idx("avg_hit_angle"),
    sweetSpot: idx("anglesweetspotpercent"),
    maxSpeed: idx("max_hit_speed"),
    avgSpeed: idx("avg_hit_speed"),
    ev50: idx("ev50"),
    fbld: idx("fbld"),
    gb: idx("gb"),
    maxDistance: idx("max_distance"),
    avgDistance: idx("avg_distance"),
    avgHrDistance: idx("avg_hr_distance"),
    ev95plus: idx("ev95plus"),
    ev95percent: idx("ev95percent"),
    barrels: idx("barrels"),
    brlPercent: idx("brl_percent"),
    brlPa: idx("brl_pa"),
  };

  const at = (row: string[], i: number) => (i >= 0 ? row[i] : undefined);

  const records: ExitVeloBarrelRecord[] = [];
  for (let r = 1; r < table.length; r++) {
    const row = table[r];
    // Skip blank trailing lines.
    if (row.length === 1 && row[0].trim() === "") continue;

    const player = formatPlayerName(at(row, col.name));
    if (!player) continue;

    records.push({
      playerId: num(at(row, col.playerId)),
      player,
      battedBallEvents: num(at(row, col.attempts)),
      avgLaunchAngle: num(at(row, col.avgHitAngle)),
      sweetSpotPct: num(at(row, col.sweetSpot)),
      maxExitVelocity: num(at(row, col.maxSpeed)),
      avgExitVelocity: num(at(row, col.avgSpeed)),
      avgBestExitVelocity: num(at(row, col.ev50)),
      flyballLinedriveExitVelocity: num(at(row, col.fbld)),
      groundballExitVelocity: num(at(row, col.gb)),
      maxDistance: num(at(row, col.maxDistance)),
      avgDistance: num(at(row, col.avgDistance)),
      avgHomeRunDistance: num(at(row, col.avgHrDistance)),
      hardHitCount: num(at(row, col.ev95plus)),
      hardHitPct: num(at(row, col.ev95percent)),
      barrels: num(at(row, col.barrels)),
      barrelPct: num(at(row, col.brlPercent)),
      barrelsPerPa: num(at(row, col.brlPa)),
    });
  }

  return records;
}

// --- Fetching --------------------------------------------------------------

/**
 * Fetch and parse the exit-velocity & barrels leaderboard for one player type.
 * Throws StatcastError on a non-OK response so callers can react to outages.
 */
export async function fetchExitVeloBarrels(
  type: StatcastType,
  season: number = currentSeasonYear(),
  min: string = STATCAST_MIN_BBE
): Promise<ExitVeloBarrelRecord[]> {
  const url =
    `${SAVANT_BASE}${STATCAST_LEADERBOARD_PATH}` +
    `?type=${type}&year=${season}&position=&team=` +
    `&min=${encodeURIComponent(min)}&csv=true`;

  const res = await fetch(url, {
    headers: { Accept: "text/csv,*/*" },
  });

  if (!res.ok) {
    throw new StatcastError(
      `Savant ${type} leaderboard request failed (status ${res.status})`,
      res.status
    );
  }

  const csv = await res.text();
  return parseExitVeloBarrels(csv);
}

/**
 * Build the combined payload by fetching both the batter and pitcher
 * leaderboards in parallel. Records are returned in Savant's default order
 * (most batted-ball events first).
 */
export async function buildStatcastPayload(
  season: number = currentSeasonYear(),
  min: string = STATCAST_MIN_BBE
): Promise<StatcastPayload> {
  const [batters, pitchers] = await Promise.all([
    fetchExitVeloBarrels("batter", season, min),
    fetchExitVeloBarrels("pitcher", season, min),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    season,
    minBattedBalls: String(min),
    source: "live",
    batters,
    pitchers,
    counts: { batters: batters.length, pitchers: pitchers.length },
    attribution: ATTRIBUTION,
  };
}
