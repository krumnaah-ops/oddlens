// ---------------------------------------------------------------------------
// Netlify Blobs persistence for the cached Statcast payload. The scheduled
// updater writes the latest leaderboard snapshot here; the public
// /api/statcast function reads it (and refreshes it on a cache miss). Kept in
// its own store namespace, separate from the player-props cache.
// ---------------------------------------------------------------------------

import { getStore } from "@netlify/blobs";
import { STATCAST_BLOB_STORE, STATCAST_LATEST_KEY } from "./config.js";
import type { StatcastPayload } from "./statcast.js";

function store() {
  // Strong consistency so a read immediately after a write never serves stale.
  return getStore({ name: STATCAST_BLOB_STORE, consistency: "strong" });
}

/** Persist the latest combined Statcast payload. */
export async function saveStatcast(payload: StatcastPayload): Promise<void> {
  await store().setJSON(STATCAST_LATEST_KEY, payload);
}

/** Read the latest cached payload, or null if nothing has been stored yet. */
export async function loadStatcast(): Promise<StatcastPayload | null> {
  const data = (await store().get(STATCAST_LATEST_KEY, { type: "json" })) as
    | StatcastPayload
    | null;
  return data ?? null;
}
