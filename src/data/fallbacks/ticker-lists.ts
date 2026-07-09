export const FALLBACK_TICKERS = [
  { ticker: "AAPL", name: "Apple Inc." },
  { ticker: "MSFT", name: "Microsoft Corporation" },
  { ticker: "NVDA", name: "NVIDIA Corporation" },
  { ticker: "TSLA", name: "Tesla Inc." },
  { ticker: "AMZN", name: "Amazon.com Inc." },
  { ticker: "GOOGL", name: "Alphabet Inc." },
  { ticker: "META", name: "Meta Platforms Inc." },
  { ticker: "NFLX", name: "Netflix Inc." },
  { ticker: "AMD", name: "Advanced Micro Devices Inc." },
  { ticker: "IBM", name: "International Business Machines" },
];

export const CRON_WARMUP_TICKERS = [
  // Mega-cap tech
  { ticker: "AAPL", name: "Apple Inc." },
  { ticker: "MSFT", name: "Microsoft Corporation" },
  { ticker: "NVDA", name: "NVIDIA Corporation" },
  { ticker: "GOOGL", name: "Alphabet Inc." },
  { ticker: "META", name: "Meta Platforms Inc." },
  { ticker: "AMZN", name: "Amazon.com Inc." },
  { ticker: "AMD", name: "Advanced Micro Devices Inc." },
  { ticker: "ORCL", name: "Oracle Corporation" },
  { ticker: "CRM", name: "Salesforce Inc." },
  { ticker: "ADBE", name: "Adobe Inc." },
  // Consumer / discretionary
  { ticker: "TSLA", name: "Tesla Inc." },
  { ticker: "NFLX", name: "Netflix Inc." },
  { ticker: "DIS", name: "The Walt Disney Company" },
  { ticker: "NKE", name: "Nike Inc." },
  { ticker: "SBUX", name: "Starbucks Corporation" },
  { ticker: "MCD", name: "McDonald's Corporation" },
  // Consumer staples / retail
  { ticker: "WMT", name: "Walmart Inc." },
  { ticker: "COST", name: "Costco Wholesale Corporation" },
  { ticker: "KO", name: "The Coca-Cola Company" },
  // Financials
  { ticker: "JPM", name: "JPMorgan Chase & Co." },
  { ticker: "BAC", name: "Bank of America Corporation" },
  { ticker: "V", name: "Visa Inc." },
  { ticker: "MA", name: "Mastercard Incorporated" },
  // Healthcare
  { ticker: "JNJ", name: "Johnson & Johnson" },
  { ticker: "LLY", name: "Eli Lilly and Company" },
  { ticker: "UNH", name: "UnitedHealth Group Incorporated" },
  // Energy / industrial / comms
  { ticker: "XOM", name: "Exxon Mobil Corporation" },
  { ticker: "CVX", name: "Chevron Corporation" },
  { ticker: "BA", name: "The Boeing Company" },
  { ticker: "CAT", name: "Caterpillar Inc." },
];

// Symbol search is served by the committed full universe (src/data/universe.json
// via src/lib/market-data/universe.ts), not a curated list here.
