import { pgTable, serial, text, timestamp, jsonb, integer, doublePrecision } from "drizzle-orm/pg-core";

export const odds = pgTable("odds", {
  id: serial("id").primaryKey(),
  eventId: text("event_id").notNull().unique(),
  sportKey: text("sport_key").notNull(),
  homeTeam: text("home_team").notNull(),
  awayTeam: text("away_team").notNull(),
  commenceTime: timestamp("commence_time"),
  oddsData: jsonb("odds_data").notNull(),
  propsData: jsonb("props_data"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ---------------------------------------------------------------------------
// Settled track record for graded props.
//
// One row per (event, player, market, line, side) that the model flagged with a
// grade (today: the "value" / VAL grade). The settle-grades function inserts a
// row as `pending` when it first sees a graded prop, then fills in the real
// outcome once the game is final — read from the MLB Stats API box score, never
// fabricated. The grade-history API aggregates these rows into the historical
// hit rate shown next to each grade in the UI, so users can see how often a
// given grade has actually cashed.
//
// `resultKey` is a deterministic dedupe key so repeated settle runs upsert the
// same row instead of duplicating it.
// ---------------------------------------------------------------------------
export const gradeResults = pgTable("grade_results", {
  id: serial("id").primaryKey(),
  resultKey: text("result_key").notNull().unique(),
  eventId: text("event_id").notNull(),
  gamePk: integer("game_pk"),
  commenceTime: timestamp("commence_time"),
  playerId: integer("player_id"),
  playerName: text("player_name").notNull(),
  market: text("market").notNull(),
  side: text("side").notNull(),
  line: doublePrecision("line"),
  grade: text("grade").notNull(),
  bestOdds: integer("best_odds"),
  // pending | hit | miss | push | void
  status: text("status").notNull().default("pending"),
  actualValue: doublePrecision("actual_value"),
  gradedAt: timestamp("graded_at").defaultNow(),
  settledAt: timestamp("settled_at"),
});
