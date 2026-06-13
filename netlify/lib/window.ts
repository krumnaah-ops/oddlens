// ---------------------------------------------------------------------------
// Active-window and game-relevance logic, derived dynamically from the day's
// game times. Pure functions so they are easy to reason about and test.
// ---------------------------------------------------------------------------

import {
  WINDOW_START_LEAD_MINUTES,
  WINDOW_END_TRAIL_MINUTES,
  RELEVANCE_LOOKAHEAD_HOURS,
  LIVE_GRACE_HOURS,
  PULL_WINDOW_TZ,
  PULL_WINDOW_START_HOUR,
  PULL_WINDOW_END_HOUR,
  PULL_WINDOW_STEP_HOURS,
} from "./config.js";
import type { ApiEvent } from "./oddsApi.js";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/** The 0-23 hour of `now` in the configured pull-window timezone. */
export function pullWindowHour(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PULL_WINDOW_TZ,
    hour: "numeric",
    hour12: false,
  }).formatToParts(now);
  const value = parts.find((p) => p.type === "hour")?.value ?? "";
  const hour = Number(value);
  if (!Number.isFinite(hour)) return NaN;
  // Some runtimes render midnight as "24" with hour12:false; normalize to 0.
  return hour === 24 ? 0 : hour;
}

/**
 * True when `now` lands on one of the day's discrete pull hours — every
 * PULL_WINDOW_STEP_HOURS from PULL_WINDOW_START_HOUR through
 * PULL_WINDOW_END_HOUR inclusive (10am, 12pm, 2pm, 4pm, 6pm Central by
 * default). The scheduled pullers run hourly and use this to skip all work —
 * including the free /events check — on any hour that is not a pull hour. DST is
 * handled automatically because the hour is evaluated in the IANA timezone, so
 * the pulls stay at the same Central wall-clock times year-round.
 */
export function isWithinPullWindow(now: Date): boolean {
  const hour = pullWindowHour(now);
  if (!Number.isFinite(hour)) return false;
  if (hour < PULL_WINDOW_START_HOUR || hour > PULL_WINDOW_END_HOUR) return false;
  return (hour - PULL_WINDOW_START_HOUR) % PULL_WINDOW_STEP_HOURS === 0;
}

export interface ActiveWindow {
  active: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
}

/**
 * Compute the active daily window from the earliest and latest game times:
 *   start = earliest commence_time - WINDOW_START_LEAD_MINUTES
 *   end   = latest   commence_time - WINDOW_END_TRAIL_MINUTES
 *
 * With no games, the window is inactive.
 */
export function computeActiveWindow(events: ApiEvent[], now: Date): ActiveWindow {
  const times = events
    .map((e) => new Date(e.commence_time).getTime())
    .filter((t) => Number.isFinite(t));

  if (times.length === 0) {
    return { active: false, startsAt: null, endsAt: null };
  }

  const earliest = Math.min(...times);
  const latest = Math.max(...times);

  const startsAt = new Date(earliest - WINDOW_START_LEAD_MINUTES * MIN);
  const endsAt = new Date(latest - WINDOW_END_TRAIL_MINUTES * MIN);
  const t = now.getTime();

  return {
    active: t >= startsAt.getTime() && t <= endsAt.getTime(),
    startsAt,
    endsAt,
  };
}

/**
 * A game is relevant when it starts within RELEVANCE_LOOKAHEAD_HOURS from now,
 * or is already live (started within the last LIVE_GRACE_HOURS).
 */
export function isRelevant(event: ApiEvent, now: Date): boolean {
  const start = new Date(event.commence_time).getTime();
  if (!Number.isFinite(start)) return false;
  const t = now.getTime();
  const upcoming = start >= t && start <= t + RELEVANCE_LOOKAHEAD_HOURS * HOUR;
  const live = start <= t && start >= t - LIVE_GRACE_HOURS * HOUR;
  return upcoming || live;
}

/** Filter to the relevant subset, preserving order. */
export function relevantEvents(events: ApiEvent[], now: Date): ApiEvent[] {
  return events.filter((e) => isRelevant(e, now));
}
