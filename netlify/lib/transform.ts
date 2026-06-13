// ---------------------------------------------------------------------------
// Transform raw The Odds API event-odds into the normalized payload we cache
// and serve. Each Over/Under prop line is grouped by (market, player, point)
// and annotated with no-vig fair odds per book.
// ---------------------------------------------------------------------------

import { MARKETS, BOOK_TITLES } from "./config.js";
import { noVig } from "./novig.js";
import type { ApiEventOdds, ApiOutcome } from "./oddsApi.js";

const MARKET_META = new Map(MARKETS.map((m) => [m.key, m]));

export interface BookLine {
  book: string;
  bookTitle: string;
  over: number | null;
  under: number | null;
  /** No-vig (fair) Over price, American odds. */
  fairOver: number | null;
  /** No-vig (fair) Under price, American odds. */
  fairUnder: number | null;
  /** No-vig (fair) Over probability, 0..1. */
  fairOverProb: number | null;
  /** No-vig (fair) Under probability, 0..1. */
  fairUnderProb: number | null;
  /** Book hold/margin on this line, percent. */
  holdPct: number | null;
}

export interface PropLine {
  market: string;
  marketLabel: string;
  type: "batter" | "pitcher";
  player: string;
  point: number | null;
  books: BookLine[];
  /** Average fair Over probability across books (consensus), 0..1. */
  consensusOverProb: number | null;
}

export interface GameProps {
  eventId: string;
  sportKey: string;
  commenceTime: string;
  homeTeam: string;
  awayTeam: string;
  batterProps: PropLine[];
  pitcherProps: PropLine[];
}

export interface PropsPayload {
  generatedAt: string;
  /** "live" = props fetched this run; "lightweight" = events-only check. */
  source: "live" | "lightweight";
  window: {
    active: boolean;
    startsAt: string | null;
    endsAt: string | null;
  };
  creditsRemaining: number | null;
  creditsUsedThisRun: number;
  gamesProcessed: number;
  games: GameProps[];
  attribution: string;
}

function lineKey(market: string, player: string, point: number | null): string {
  return `${market}::${player}::${point ?? ""}`;
}

/**
 * Build the per-game normalized props from a single event-odds response.
 * Returns the game with empty prop arrays when no usable markets are present.
 */
export function transformEvent(event: ApiEventOdds): GameProps {
  // group key -> PropLine being assembled
  const lines = new Map<string, PropLine>();

  for (const book of event.bookmakers ?? []) {
    for (const market of book.markets ?? []) {
      const meta = MARKET_META.get(market.key);
      if (!meta) continue; // ignore markets we don't track

      // Pair Over/Under outcomes by player + point.
      const byPlayerPoint = new Map<
        string,
        { over?: ApiOutcome; under?: ApiOutcome }
      >();
      for (const oc of market.outcomes ?? []) {
        const player = oc.description ?? "";
        const point = oc.point ?? null;
        const k = `${player}::${point ?? ""}`;
        const entry = byPlayerPoint.get(k) ?? {};
        if (oc.name.toLowerCase() === "over") entry.over = oc;
        else if (oc.name.toLowerCase() === "under") entry.under = oc;
        byPlayerPoint.set(k, entry);
      }

      for (const [, pair] of byPlayerPoint) {
        const sample = pair.over ?? pair.under;
        if (!sample) continue;
        const player = sample.description ?? "";
        if (!player) continue;
        const point = sample.point ?? null;

        const key = lineKey(market.key, player, point);
        let line = lines.get(key);
        if (!line) {
          line = {
            market: market.key,
            marketLabel: meta.label,
            type: meta.type,
            player,
            point,
            books: [],
            consensusOverProb: null,
          };
          lines.set(key, line);
        }

        const over = pair.over?.price ?? null;
        const under = pair.under?.price ?? null;
        const fair = noVig(over, under);

        line.books.push({
          book: book.key,
          bookTitle: BOOK_TITLES[book.key] ?? book.title ?? book.key,
          over,
          under,
          fairOver: fair?.fairOver ?? null,
          fairUnder: fair?.fairUnder ?? null,
          fairOverProb: fair?.fairOverProb ?? null,
          fairUnderProb: fair?.fairUnderProb ?? null,
          holdPct: fair?.holdPct ?? null,
        });
      }
    }
  }

  // Compute consensus fair Over probability and sort books for stable output.
  const allLines: PropLine[] = [];
  for (const line of lines.values()) {
    line.books.sort((a, b) => a.book.localeCompare(b.book));
    const probs = line.books
      .map((b) => b.fairOverProb)
      .filter((p): p is number => p != null);
    line.consensusOverProb =
      probs.length > 0 ? probs.reduce((s, p) => s + p, 0) / probs.length : null;
    allLines.push(line);
  }

  // Sort lines by player then market for predictable rendering.
  allLines.sort(
    (a, b) =>
      a.player.localeCompare(b.player) || a.market.localeCompare(b.market)
  );

  return {
    eventId: event.id,
    sportKey: event.sport_key,
    commenceTime: event.commence_time,
    homeTeam: event.home_team,
    awayTeam: event.away_team,
    batterProps: allLines.filter((l) => l.type === "batter"),
    pitcherProps: allLines.filter((l) => l.type === "pitcher"),
  };
}
