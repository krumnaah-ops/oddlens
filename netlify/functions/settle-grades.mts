// ---------------------------------------------------------------------------
// Scheduled settler that builds the graded-prop track record.
//
// Each run it:
//   1. Loads recently-finished games from the `odds` table.
//   2. Re-derives the value (VAL) grade from the stored odds and records each
//      graded Over/Yes prop as `pending` in `grade_results` (idempotent).
//   3. For any still-pending props, resolves the final MLB box score and settles
//      them hit/miss/push against the real result.
//
// All outcomes come from the public MLB Stats API — nothing is fabricated. Props
// whose game isn't final yet, or that can't be confidently matched, simply stay
// pending and are retried on the next run. The /api/grade-history endpoint reads
// these settled rows to show how often each grade actually cashes.
// ---------------------------------------------------------------------------

import type { Config } from "@netlify/functions";
import { and, eq, gt, lt } from "drizzle-orm";
import { db } from "../../db/index.js";
import { odds, gradeResults } from "../../db/schema.js";
import { gradeEventProps, resolveFinalGame, settleGradedProp } from "../lib/grades.js";

// How far back to look for finished games, and how long after first pitch to
// start attempting settlement (the Final-status check is the real gate).
const LOOKBACK_MS = 4 * 24 * 60 * 60 * 1000; // 4 days
const MIN_AGE_MS = 60 * 60 * 1000; // started at least 1h ago
const MAX_EVENTS_PER_RUN = 40;

export default async () => {
  const now = Date.now();
  const lookback = new Date(now - LOOKBACK_MS);
  const youngest = new Date(now - MIN_AGE_MS);

  let rows: any[];
  try {
    rows = await db
      .select()
      .from(odds)
      .where(and(gt(odds.commenceTime, lookback), lt(odds.commenceTime, youngest)));
  } catch (err) {
    console.error("settle-grades: failed to read odds rows:", err);
    return;
  }

  rows = rows.slice(0, MAX_EVENTS_PER_RUN);
  if (rows.length === 0) {
    console.log("settle-grades: no recently-finished games to settle.");
    return;
  }

  let recorded = 0;
  let settled = 0;

  for (const row of rows) {
    const graded = gradeEventProps(row.eventId, row.propsData);
    if (graded.length === 0) continue;

    // 1. Record any newly-seen graded props as pending (idempotent on resultKey).
    for (const g of graded) {
      try {
        const res = await db
          .insert(gradeResults)
          .values({
            resultKey: g.resultKey,
            eventId: g.eventId,
            commenceTime: row.commenceTime,
            playerName: g.playerName,
            market: g.market,
            side: g.side,
            line: g.line,
            grade: g.grade,
            bestOdds: g.bestOdds ?? null,
            status: "pending",
          })
          .onConflictDoNothing({ target: gradeResults.resultKey });
        // node-postgres returns rowCount; netlify driver may not — guard both.
        if ((res as any)?.rowCount) recorded += (res as any).rowCount;
      } catch (err) {
        console.error(`settle-grades: insert failed for ${g.resultKey}:`, err);
      }
    }

    // 2. Settle still-pending props for this event against the final box score.
    let pending: any[];
    try {
      pending = await db
        .select()
        .from(gradeResults)
        .where(and(eq(gradeResults.eventId, row.eventId), eq(gradeResults.status, "pending")));
    } catch (err) {
      console.error(`settle-grades: pending read failed for ${row.eventId}:`, err);
      continue;
    }
    if (pending.length === 0) continue;

    const final = await resolveFinalGame(
      row.homeTeam,
      row.awayTeam,
      row.commenceTime ? new Date(row.commenceTime) : null
    );
    if (!final) continue; // not final yet / no confident match — retry later

    for (const pr of pending) {
      const outcome = settleGradedProp(
        { playerName: pr.playerName, market: pr.market, line: pr.line } as any,
        final.boxscore
      );
      if (!outcome) continue; // player not found in box score — leave pending
      try {
        await db
          .update(gradeResults)
          .set({
            status: outcome.status,
            actualValue: outcome.actualValue,
            gamePk: final.gamePk,
            settledAt: new Date(),
          })
          .where(eq(gradeResults.id, pr.id));
        settled++;
      } catch (err) {
        console.error(`settle-grades: update failed for id=${pr.id}:`, err);
      }
    }
  }

  console.log(
    `settle-grades: scanned ${rows.length} game(s); recorded ${recorded} new graded prop(s); settled ${settled}.`
  );
};

export const config: Config = {
  // Hourly: games finish throughout the evening, and settlement is free (MLB
  // Stats API). Each run only acts on games that are actually final.
  schedule: "0 * * * *",
};
