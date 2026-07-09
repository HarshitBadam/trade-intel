// Ops tool: load a ticker's news into the Astra store and read it back.
//
//   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/load-news.ts CCL
//   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/load-news.ts CCL --prune-dry-run
//
// The react-server condition is required because the store modules import
// "server-only", which throws under a plain Node resolution. Env is parsed from
// .env.local manually so it is set BEFORE the store modules (which read
// process.env at import time via src/lib/config.ts) are dynamically imported.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

function loadEnvLocal(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(here, "..", ".env.local");
  let raw: string;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch {
    console.warn(`No .env.local at ${envPath}; relying on ambient env.`);
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

async function main(): Promise<void> {
  loadEnvLocal();

  const args = process.argv.slice(2);
  const pruneDryRun = args.includes("--prune-dry-run");
  const ticker = args.find((a) => !a.startsWith("--"))?.toUpperCase();
  if (!ticker) {
    console.error("Usage: load-news.ts TICKER [--prune-dry-run]");
    process.exit(1);
  }

  // Dynamic import AFTER env is loaded so config.ts sees the keys.
  const store = await import("../src/lib/market-data/news-store");
  const providers = await import("../src/lib/market-data/news-loaders");

  const mode = await store.ensureAnalysisCollection();
  const collections = await store.listNewsStoreCollections();
  console.log(`Astra collections: ${collections.join(", ")}`);
  console.log(`Analysis store mode: ${mode}`);

  console.log(`\nLoading news for ${ticker}...`);
  const result = await providers.loadTickerNews(ticker);
  console.log(
    `Fetched ${result.fetched} from Polygon | ` +
      `upserted ${result.upserted} (inserted ${result.inserted}, ` +
      `skipped-AI ${result.skippedAi}).`
  );

  const total = await store.countTickerArticles(ticker);
  console.log(`Total stored rows for ${ticker}: ${total}`);

  const newest = await store.readTickerArticles(ticker, 3);
  console.log("Newest 3 stored rows:");
  for (const r of newest) {
    console.log(
      `  - [${r.metadata.publication_date}] ` +
        `(${r.metadata.sentiment}/${r.metadata.label_source}) ${r.metadata.title}`
    );
  }

  const analysis = await store.readAnalysisDoc(ticker);
  console.log("\nAnalysis doc:");
  console.log(analysis ? JSON.stringify(analysis, null, 2) : "  (none yet)");

  if (pruneDryRun) {
    const count = await store.countPrunableArticles(90);
    console.log(
      `\nPrune dry-run: ${count} article rows older than 90 days (not deleted).`
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
