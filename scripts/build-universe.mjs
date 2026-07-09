#!/usr/bin/env node
// Builds the committed search universe (src/data/universe.json) from Alpaca's
// /v2/assets: every active, tradable, exchange-listed US equity (incl. ETFs).
//
//   node --env-file=.env.local scripts/build-universe.mjs
//
// Assets live on the TRADING API domain (paper-api.alpaca.markets for paper
// keys, api.alpaca.markets for live keys) — NOT data.alpaca.markets. Both
// hosts are tried so either key kind works.
//
// Crypto is deliberately EXCLUDED for now: the app's Alpaca layer
// (src/lib/market-data/alpaca.ts) only speaks the /v2/stocks bars/snapshot
// endpoints, so a crypto symbol would be searchable but unchartable — exactly
// the broken-row state the universe exists to rule out. Revisit once a crypto
// data path (v1beta3/crypto) exists.

import { writeFileSync } from "node:fs";

const KEY = process.env.ALPACA_API_KEY_ID;
const SECRET = process.env.ALPACA_API_SECRET_KEY;
if (!KEY || !SECRET) {
  console.error(
    "Missing ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY. Run with:\n" +
      "  node --env-file=.env.local scripts/build-universe.mjs"
  );
  process.exit(1);
}

// Real listed venues only — the point of the filter is excluding OTC junk
// (shells, delisted ADR remnants, pink sheets) that has no news coverage and
// often no chartable bars.
const LISTED_EXCHANGES = new Set(["NYSE", "NASDAQ", "AMEX", "ARCA", "BATS"]);

// Seed block: the recognizable names anyone would type first. Placed at the
// head of the output so the later cron/cold-start loader can walk the file
// top-to-bottom and warm the demo-relevant names within minutes. Derived from
// CRON_WARMUP_TICKERS (src/data/fallbacks/ticker-lists.ts) plus the obvious
// Fortune-100 mega-caps and flagship ETFs.
const SEED_SYMBOLS = [
  "AAPL", "MSFT", "NVDA", "GOOGL", "META", "AMZN", "AMD", "ORCL", "CRM",
  "ADBE", "TSLA", "NFLX", "DIS", "NKE", "SBUX", "MCD", "WMT", "COST", "KO",
  "JPM", "BAC", "V", "MA", "JNJ", "LLY", "UNH", "XOM", "CVX", "BA", "CAT",
  "GOOG", "AVGO", "INTC", "CSCO", "QCOM", "TXN", "IBM", "NOW", "INTU",
  "UBER", "PYPL", "PLTR",
  "PEP", "PG", "HD", "LOW", "TGT", "CL", "PM",
  "ABBV", "MRK", "PFE", "TMO", "ABT", "BMY", "AMGN", "GILD", "CVS",
  "WFC", "C", "GS", "MS", "AXP", "BLK", "SCHW", "COF",
  "T", "VZ", "TMUS", "COP", "GE", "HON", "UPS", "LMT", "DE", "F", "GM",
  "RTX", "FDX", "MMM", "UNP",
  "SPY", "QQQ", "VOO", "VTI", "IWM", "DIA",
];

// Mirror of sanitizeTicker (src/lib/market-data/transforms.ts): the details
// route strips anything outside [A-Z.] and truncates at 6 chars, so a symbol
// that wouldn't survive it round-trip (long preferred-share/warrant forms
// like "BML.PRG") would navigate to a DIFFERENT symbol — an unroutable row.
function isRoutable(symbol) {
  return /^[A-Z.]{1,6}$/.test(symbol);
}

async function fetchAssets() {
  const hosts = [
    "https://paper-api.alpaca.markets",
    "https://api.alpaca.markets",
  ];
  let lastError;
  for (const host of hosts) {
    const res = await fetch(
      `${host}/v2/assets?status=active&asset_class=us_equity`,
      {
        headers: {
          "APCA-API-KEY-ID": KEY,
          "APCA-API-SECRET-KEY": SECRET,
        },
      }
    );
    if (res.ok) return res.json();
    lastError = new Error(`${host} responded ${res.status} ${res.statusText}`);
    // Only an auth mismatch (paper key on live host or vice versa) warrants
    // trying the other host; anything else is a real failure.
    if (res.status !== 401 && res.status !== 403) throw lastError;
    console.error(`${lastError.message} — trying next host`);
  }
  throw lastError;
}

function breakdown(assets) {
  const counts = {};
  for (const a of assets) counts[a.exchange] = (counts[a.exchange] ?? 0) + 1;
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([ex, n]) => `${ex}: ${n}`)
    .join(", ");
}

const assets = await fetchAssets();
console.log(`Fetched ${assets.length} active us_equity assets`);
console.log(`Pre-filter exchanges  — ${breakdown(assets)}`);

const bySymbol = new Map();
for (const a of assets) {
  if (a.tradable !== true) continue;
  if (a.status !== "active") continue;
  if (!LISTED_EXCHANGES.has(a.exchange)) continue;
  if (!isRoutable(a.symbol)) continue;
  if (!bySymbol.has(a.symbol)) bySymbol.set(a.symbol, a);
}
const kept = [...bySymbol.values()];
console.log(`Post-filter exchanges — ${breakdown(kept)}`);

const entries = kept.map((a) => ({
  symbol: a.symbol,
  name: (a.name ?? "").trim() || a.symbol,
}));

const entryBySymbol = new Map(entries.map((e) => [e.symbol, e]));
const seed = SEED_SYMBOLS.map((s) => entryBySymbol.get(s)).filter(Boolean);
const seedSet = new Set(seed.map((e) => e.symbol));
const rest = entries
  .filter((e) => !seedSet.has(e.symbol))
  .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
const tickers = [...seed, ...rest];

const missingSeeds = SEED_SYMBOLS.filter((s) => !seedSet.has(s));
if (missingSeeds.length > 0) {
  console.warn(`Seed symbols absent from Alpaca data: ${missingSeeds.join(", ")}`);
}

// One ticker per line keeps the committed file diffable across rebuilds.
const tickerLines = tickers.map((t) => `    ${JSON.stringify(t)}`);
const json =
  `{\n` +
  `  "builtAt": ${JSON.stringify(new Date().toISOString())},\n` +
  `  "source": "alpaca:/v2/assets",\n` +
  `  "count": ${tickers.length},\n` +
  `  "tickers": [\n${tickerLines.join(",\n")}\n  ]\n` +
  `}\n`;

const outUrl = new URL("../src/data/universe.json", import.meta.url);
writeFileSync(outUrl, json);

console.log(`Wrote ${tickers.length} tickers (${seed.length} seed) to src/data/universe.json`);
console.log("Samples:");
for (const t of [...tickers.slice(0, 5), ...rest.slice(0, 5)]) {
  console.log(`  ${t.symbol.padEnd(6)} ${t.name}`);
}
