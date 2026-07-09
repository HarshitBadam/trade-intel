// Ops tool: run the deep-analysis engine for one ticker and read the result back.
//
//   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/analyze-ticker.ts CCL
//   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/analyze-ticker.ts CCL --force
//
// The react-server condition is required because the store/engine modules import
// "server-only", which throws under plain Node resolution. Env is parsed from
// .env.local manually so it is set BEFORE the modules (which read process.env at
// import time via src/lib/config.ts) are dynamically imported. Mirrors
// scripts/load-news.ts.

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
    // Ambient env wins so an inline override (e.g. GROQ_ANALYSIS_MODEL=...) on
    // the command line takes precedence over .env.local — this is what the D14
    // failed-run verification relies on.
    if (!(key in process.env)) process.env[key] = value;
  }
}

async function main(): Promise<void> {
  loadEnvLocal();

  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const ticker = args.find((a) => !a.startsWith("--"))?.toUpperCase();
  if (!ticker) {
    console.error("Usage: analyze-ticker.ts TICKER [--force]");
    process.exit(1);
  }

  // Dynamic import AFTER env is loaded so config.ts sees the keys.
  const store = await import("../src/lib/market-data/news-store");
  const analysis = await import("../src/lib/market-data/analysis");

  const mode = await store.ensureAnalysisCollection();
  console.log(`Analysis store mode: ${mode}`);
  console.log(`Analysis model: ${process.env.GROQ_ANALYSIS_MODEL ?? "llama-3.1-8b-instant"}`);

  const gate = await analysis.shouldAnalyzeTicker(ticker);
  console.log(
    `\nshouldAnalyzeTicker(${ticker}): run=${gate.run} reason=${gate.reason}`
  );

  if (force) {
    console.log(`\nForcing analyzeTicker(${ticker})...`);
    const summary = await analysis.analyzeTicker(ticker, { force: true });
    console.log(
      `Result: analyzed ${summary.analyzed}, relabeled ${summary.relabeled}, ` +
        `verdict ${summary.verdict ?? "(none)"}` +
        (summary.skipped ? ` [skipped: ${summary.skipped}]` : "")
    );
  } else {
    console.log(`\nRunning maybeAnalyzeTicker(${ticker})...`);
    const status = await analysis.maybeAnalyzeTicker(ticker);
    if (status.status === "analyzed") {
      const s = status.summary;
      console.log(
        `Result: analyzed ${s.analyzed}, relabeled ${s.relabeled}, ` +
          `verdict ${s.verdict ?? "(none)"}`
      );
    } else {
      console.log(`Result: ${status.status} (${status.reason})`);
    }
  }

  const doc = await store.readAnalysisDoc(ticker);
  console.log("\nAnalysis doc (as stored):");
  console.log(doc ? JSON.stringify(doc, null, 2) : "  (none)");

  const rows = await store.readTickerArticles(ticker, 3);
  console.log("\n3 sample stored rows (read back):");
  for (const r of rows) {
    console.log(
      `  - [${r.metadata.publication_date}] ` +
        `(${r.metadata.sentiment}/${r.metadata.importance}/` +
        `${r.metadata.label_source}) ${r.metadata.title}`
    );
    if (r.metadata.key_observations) {
      console.log(`      obs: ${r.metadata.key_observations}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
