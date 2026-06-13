// ---------------------------------------------------------------------------
// Public API: GET /api/grade-history
//
// Returns the settled track record for graded props so the dashboard can show,
// next to each grade, how often that grade has actually cashed. Reads straight
// from the `grade_results` table (populated by settle-grades.mts from real MLB
// box scores) — it performs no upstream calls and fabricates nothing.
//
// Response shape:
//   {
//     generatedAt: ISO,
//     pending: number,            // graded props awaiting their game's result
//     lastSettledAt: ISO | null,
//     grades: {
//       value: {
//         label, settled, hits, misses, pushes,
//         hitRate,                // % of decided (non-push) props that cashed
//         byMarket: { <market>: { settled, hits, hitRate } }
//       }
//     }
//   }
//
// hitRate is null until a grade has any decided props, so the frontend can show
// a "building history" state instead of a misleading 0%.
// ---------------------------------------------------------------------------

import type { Config } from "@netlify/functions";
import { db } from "../../db/index.js";
import { gradeResults } from "../../db/schema.js";

function json(body: unknown, status: number, cache?: string): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cache) headers["cache-control"] = cache;
  return new Response(JSON.stringify(body), { status, headers });
}

const GRADE_LABELS: Record<string, string> = {
  value: "Value (VAL)",
};

const MARKET_LABELS: Record<string, string> = {
  batter_home_runs: "Home Runs",
  batter_total_bases: "Total Bases",
  batter_hits_runs_rbis: "Hits + Runs + RBIs",
  pitcher_strikeouts: "Strikeouts",
  pitcher_outs: "Outs Recorded",
};

interface Tally {
  settled: number;
  hits: number;
  misses: number;
  pushes: number;
  byMarket: Record<string, { settled: number; hits: number; misses: number }>;
}

function rate(hits: number, misses: number): number | null {
  const decided = hits + misses;
  return decided > 0 ? Math.round((hits / decided) * 1000) / 10 : null;
}

export default async () => {
  let rows: any[];
  try {
    rows = await db.select().from(gradeResults);
  } catch (err) {
    console.error("grade-history: database read failed:", err);
    return json(
      { generatedAt: new Date().toISOString(), pending: 0, lastSettledAt: null, grades: {} },
      200
    );
  }

  const tallies: Record<string, Tally> = {};
  let pending = 0;
  let lastSettledAt: number | null = null;

  for (const r of rows) {
    if (r.status === "pending") {
      pending++;
      continue;
    }
    if (r.settledAt) {
      const t = new Date(r.settledAt).getTime();
      if (lastSettledAt === null || t > lastSettledAt) lastSettledAt = t;
    }

    const grade = r.grade || "value";
    const tally =
      tallies[grade] ||
      (tallies[grade] = { settled: 0, hits: 0, misses: 0, pushes: 0, byMarket: {} });

    if (r.status === "push") {
      tally.pushes++;
      continue;
    }

    tally.settled++;
    const market = r.market || "unknown";
    const m =
      tally.byMarket[market] || (tally.byMarket[market] = { settled: 0, hits: 0, misses: 0 });
    m.settled++;
    if (r.status === "hit") {
      tally.hits++;
      m.hits++;
    } else if (r.status === "miss") {
      tally.misses++;
      m.misses++;
    }
  }

  const grades: Record<string, unknown> = {};
  for (const [grade, t] of Object.entries(tallies)) {
    const byMarket: Record<string, unknown> = {};
    for (const [mk, m] of Object.entries(t.byMarket)) {
      byMarket[mk] = {
        label: MARKET_LABELS[mk] || mk,
        settled: m.settled,
        hits: m.hits,
        hitRate: rate(m.hits, m.misses),
      };
    }
    grades[grade] = {
      label: GRADE_LABELS[grade] || grade,
      settled: t.settled,
      hits: t.hits,
      misses: t.misses,
      pushes: t.pushes,
      hitRate: rate(t.hits, t.misses),
      byMarket,
    };
  }

  return json(
    {
      generatedAt: new Date().toISOString(),
      pending,
      lastSettledAt: lastSettledAt ? new Date(lastSettledAt).toISOString() : null,
      grades,
    },
    200,
    "public, max-age=300"
  );
};

export const config: Config = {
  path: "/api/grade-history",
};
