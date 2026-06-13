// ---------------------------------------------------------------------------
// Netlify Blobs persistence for the cached props payload. The scheduled updater
// writes the latest payload here; the public /api/mlb-props function reads it.
// Reads and writes go through a single store namespace and key.
// ---------------------------------------------------------------------------

import { getStore } from "@netlify/blobs";
import { BLOB_STORE, BLOB_LATEST_KEY } from "./config.js";
import type { PropsPayload } from "./transform.js";

function store() {
  // Strong consistency so the public API never serves a stale read immediately
  // after the updater writes a fresh payload.
  return getStore({ name: BLOB_STORE, consistency: "strong" });
}

/** Persist the latest combined payload. */
export async function savePayload(payload: PropsPayload): Promise<void> {
  await store().setJSON(BLOB_LATEST_KEY, payload);
}

/** Read the latest cached payload, or null if nothing has been stored yet. */
export async function loadPayload(): Promise<PropsPayload | null> {
  const data = (await store().get(BLOB_LATEST_KEY, { type: "json" })) as
    | PropsPayload
    | null;
  return data ?? null;
}
