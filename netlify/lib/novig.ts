// ---------------------------------------------------------------------------
// No-vig (fair) odds helpers.
//
// Sportsbooks bake a margin ("vig"/"juice"/"hold") into a two-way market so the
// implied probabilities of Over and Under sum to more than 100%. Removing the
// vig means renormalizing those implied probabilities so they sum to exactly
// 100%, then converting the fair probabilities back into prices.
// ---------------------------------------------------------------------------

/** Convert American odds to implied probability (0..1). */
export function americanToImpliedProb(american: number): number {
  if (american > 0) return 100 / (american + 100);
  return -american / (-american + 100);
}

/** Convert a probability (0..1) back to American odds (rounded). */
export function probToAmerican(prob: number): number {
  if (prob <= 0 || prob >= 1) return 0;
  // Decimal odds = 1 / prob. Favorites (>0.5) are negative American odds.
  if (prob > 0.5) return -Math.round((prob / (1 - prob)) * 100);
  return Math.round(((1 - prob) / prob) * 100);
}

export interface NoVigResult {
  /** Fair (no-vig) probability of the Over, 0..1. */
  fairOverProb: number;
  /** Fair (no-vig) probability of the Under, 0..1. */
  fairUnderProb: number;
  /** Fair Over price in American odds. */
  fairOver: number;
  /** Fair Under price in American odds. */
  fairUnder: number;
  /** The book's hold/margin on this market, as a percentage (e.g. 4.5). */
  holdPct: number;
}

/**
 * Remove the vig from a two-way Over/Under market.
 *
 * Returns `null` when either side is missing — a one-sided line has no fair
 * value to normalize against.
 */
export function noVig(
  overAmerican: number | null | undefined,
  underAmerican: number | null | undefined
): NoVigResult | null {
  if (overAmerican == null || underAmerican == null) return null;
  if (!Number.isFinite(overAmerican) || !Number.isFinite(underAmerican)) return null;

  const overImplied = americanToImpliedProb(overAmerican);
  const underImplied = americanToImpliedProb(underAmerican);
  const overround = overImplied + underImplied;
  if (overround <= 0) return null;

  const fairOverProb = overImplied / overround;
  const fairUnderProb = underImplied / overround;

  return {
    fairOverProb,
    fairUnderProb,
    fairOver: probToAmerican(fairOverProb),
    fairUnder: probToAmerican(fairUnderProb),
    // overround of 1.045 -> 4.5% hold
    holdPct: Math.round((overround - 1) * 1000) / 10,
  };
}
