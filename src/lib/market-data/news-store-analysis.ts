import "server-only";

import type { AnalysisDoc } from "./types";
import { analysisRef } from "./news-store-client";

export async function readAnalysisDoc(ticker: string): Promise<AnalysisDoc | null> {
  const { collection, id } = await analysisRef(ticker);
  return collection.findOne({ _id: id });
}

// Analysis and ingestion own disjoint fields, so partial writes must never
// replace the whole document.
export async function writeAnalysisDoc(doc: AnalysisDoc): Promise<void> {
  const { collection, id, onInsert } = await analysisRef(doc._id ?? doc.ticker);
  const { _id: _ignored, ...fields } = doc;
  await collection.updateOne(
    { _id: id },
    { $set: { ...fields, ...onInsert } },
    { upsert: true }
  );
}

export function buildManifestPublishUpdate(doc: AnalysisDoc): {
  fields: Record<string, unknown>;
  unset: Record<string, "">;
} {
  const { _id: _ignored, refresh_staging_at: _stagingIgnored, ...fields } = doc;
  return { fields, unset: { refresh_staging_at: "" } };
}

// The generation filter is the publication CAS. Staged article rows are not
// authoritative until their IDs enter this manifest, and every successful
// publish clears the fail-closed staging marker.
export async function publishAnalysisDoc(
  doc: AnalysisDoc,
  expectedGeneration: number | null
): Promise<boolean> {
  const { collection, id, onInsert } = await analysisRef(doc._id ?? doc.ticker);
  const { fields, unset } = buildManifestPublishUpdate(doc);
  const generationFilter =
    expectedGeneration === null
      ? { generation: { $exists: false } }
      : { generation: expectedGeneration };
  const result = await collection.updateOne(
    { _id: id, ...generationFilter },
    {
      $set: { ...fields, ...onInsert },
      $unset: unset,
    },
    { upsert: expectedGeneration === null }
  );
  return result.modifiedCount > 0 || result.upsertedCount > 0;
}

// Written before article upserts so no-manifest readers fail closed while
// unpublished rows are visible in storage.
export async function markRefreshStaging(
  ticker: string,
  when: string = new Date().toISOString()
): Promise<void> {
  const { collection, id, onInsert } = await analysisRef(ticker);
  await collection.updateOne(
    { _id: id },
    { $set: { ...onInsert, refresh_staging_at: when } },
    { upsert: true }
  );
}

// This is an ingestion timestamp, not verdict freshness; only analysis writes
// analyzed_at.
export async function touchNewsLoadedAt(
  ticker: string,
  when: string = new Date().toISOString()
): Promise<void> {
  const { collection, id, onInsert } = await analysisRef(ticker);
  await collection.updateOne(
    { _id: id },
    { $set: { ...onInsert, news_loaded_at: when } },
    { upsert: true }
  );
}

export async function recordAnalysisError(
  ticker: string,
  errorCode: string
): Promise<void> {
  const { collection, id, onInsert } = await analysisRef(ticker);
  await collection.updateOne(
    { _id: id },
    { $set: { ...onInsert, last_error_code: errorCode } },
    { upsert: true }
  );
}
