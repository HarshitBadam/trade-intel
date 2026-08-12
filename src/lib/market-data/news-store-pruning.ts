import "server-only";

import { newsCollection } from "./news-store-client";

const DAY_MS = 24 * 60 * 60 * 1000;

function pruneCutoff(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}

function prunableFilter(cutoffDay: string) {
  // Publication dates are ISO day strings, so lexical ordering is
  // chronological. Missing and empty legacy dates must never be deleted.
  return {
    "metadata.publication_date": { $exists: true, $gt: "", $lt: cutoffDay },
  };
}

export async function countPrunableArticles(days = 90): Promise<number> {
  return newsCollection().countDocuments(prunableFilter(pruneCutoff(days)), 1000);
}

export async function pruneOldArticles(days = 90): Promise<number> {
  const result = await newsCollection().deleteMany(prunableFilter(pruneCutoff(days)));
  return result.deletedCount;
}
