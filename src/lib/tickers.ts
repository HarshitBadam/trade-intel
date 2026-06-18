// Resolves company names / symbols mentioned in free-form chat text into ticker
// symbols, so the chat layer can attach live quotes. Covers the well-known names
// a showcase is likely to be asked about; anything unknown simply yields no
// ticker (the model then answers from general knowledge without inventing data).

const NAME_TO_TICKER: Record<string, string> = {
  apple: "AAPL",
  microsoft: "MSFT",
  nvidia: "NVDA",
  tesla: "TSLA",
  amazon: "AMZN",
  google: "GOOGL",
  alphabet: "GOOGL",
  meta: "META",
  facebook: "META",
  netflix: "NFLX",
  amd: "AMD",
  ibm: "IBM",
  micron: "MU",
  intel: "INTC",
  oracle: "ORCL",
  salesforce: "CRM",
  adobe: "ADBE",
  qualcomm: "QCOM",
  broadcom: "AVGO",
  palantir: "PLTR",
  uber: "UBER",
  airbnb: "ABNB",
  coinbase: "COIN",
  paypal: "PYPL",
  disney: "DIS",
  nike: "NKE",
  starbucks: "SBUX",
  walmart: "WMT",
  costco: "COST",
  boeing: "BA",
  ford: "F",
  "general motors": "GM",
  "jpmorgan": "JPM",
  "jp morgan": "JPM",
  visa: "V",
  mastercard: "MA",
  infosys: "INFY",
  spotify: "SPOT",
  shopify: "SHOP",
  snowflake: "SNOW",
  zoom: "ZM",
};

// Common all-caps tokens that are NOT tickers, so we don't fetch quotes for them.
const NOT_TICKERS = new Set([
  "A", "I", "AI", "AN", "AND", "OR", "THE", "US", "USA", "EV", "EVS", "IPO",
  "CEO", "CFO", "CTO", "COO", "ETF", "GDP", "OK", "AM", "PM", "USD", "EPS",
  "PE", "ROI", "API", "FAQ", "TV", "VS", "Q1", "Q2", "Q3", "Q4", "ESG", "ATH",
  "IT", "ID", "UI", "UX", "ML", "LLM", "RAG", "SEC", "FED", "YOY", "QOQ",
]);

/**
 * Extracts likely tickers from text: known company names plus explicit
 * uppercase symbols (e.g. "AAPL", "MU"). De-duplicated, capped for safety.
 */
export function resolveTickers(text: string, max = 4): string[] {
  if (!text) return [];
  const found = new Set<string>();

  const lower = text.toLowerCase();
  for (const [name, ticker] of Object.entries(NAME_TO_TICKER)) {
    // Word-boundary match so "intel" doesn't fire on "intelligence".
    const re = new RegExp(`\\b${name}\\b`, "i");
    if (re.test(lower)) found.add(ticker);
  }

  for (const token of text.match(/\b[A-Z]{1,5}\b/g) ?? []) {
    if (!NOT_TICKERS.has(token) && token.length >= 2) found.add(token);
  }

  return [...found].slice(0, max);
}
