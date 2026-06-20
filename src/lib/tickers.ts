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
  wipro: "WIT",
  spotify: "SPOT",
  shopify: "SHOP",
  snowflake: "SNOW",
  zoom: "ZM",
  // Indices have no free-tier quote but resolving them keeps the comparison
  // subject explicit so the model addresses it rather than dropping it.
  nasdaq: "IXIC",
  "dow jones": "DJI",
  "s&p 500": "GSPC",
  "s&p500": "GSPC",
};

const NOT_TICKERS = new Set([
  "A", "I", "AI", "AN", "AND", "OR", "THE", "US", "USA", "EV", "EVS", "IPO",
  "CEO", "CFO", "CTO", "COO", "ETF", "GDP", "OK", "AM", "PM", "USD", "EPS",
  "PE", "ROI", "API", "FAQ", "TV", "VS", "Q1", "Q2", "Q3", "Q4", "ESG", "ATH",
  "IT", "ID", "UI", "UX", "ML", "LLM", "RAG", "SEC", "FED", "YOY", "QOQ",
]);

export function resolveTickers(text: string, max = 4): string[] {
  if (!text) return [];
  const found = new Set<string>();

  const lower = text.toLowerCase();
  for (const [name, ticker] of Object.entries(NAME_TO_TICKER)) {
    const re = new RegExp(`\\b${name}\\b`, "i");
    if (re.test(lower)) found.add(ticker);
  }

  for (const token of text.match(/\b[A-Z]{1,5}\b/g) ?? []) {
    if (!NOT_TICKERS.has(token) && token.length >= 2) found.add(token);
  }

  return [...found].slice(0, max);
}
