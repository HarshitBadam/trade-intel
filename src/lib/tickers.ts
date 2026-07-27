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
  robinhood: "HOOD",
  paypal: "PYPL",
  disney: "DIS",
  nike: "NKE",
  starbucks: "SBUX",
  walmart: "WMT",
  costco: "COST",
  boeing: "BA",
  ford: "F",
  "general motors": "GM",
  rivian: "RIVN",
  lucid: "LCID",
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

// Plenty of everyday words are also listed symbols (BRO, SELF, YOU, DOO, ALL),
// so an uppercase token alone is not evidence of a ticker. These are only read
// as symbols when the message gives a cue such as "$BRO" or "BRO stock".
const COMMON_WORDS = new Set([
  "AB", "ABLE", "ABOUT", "AFTER", "AGAIN", "ALL", "ALSO", "ANY", "ARE", "AS",
  "ASK", "AT", "AWAY", "BACK", "BAD", "BE", "BEEN", "BEST", "BIG", "BOTH",
  "BRO", "BUT", "BUY", "BY", "CALL", "CAME", "CAN", "CANT", "COME", "COOL",
  "DAMN", "DEAD", "DID", "DIE", "DO", "DOES", "DOIN", "DONE", "DONT", "DOO",
  "DOWN", "DUDE", "EACH", "ELSE", "EVEN", "EVER", "FAR", "FEW", "FIND", "FINE",
  "FIVE", "FOR", "FOUR", "FROM", "FUCK", "GET", "GIVE", "GO", "GOD", "GOES",
  "GONE", "GOOD", "GOT", "GUY", "HAD", "HAS", "HATE", "HAVE", "HE", "HELL",
  "HELP", "HER", "HERE", "HEY", "HIM", "HIS", "HOW", "HUGE", "IF", "ILL", "IM",
  "IN", "INTO", "IS", "IT", "ITS", "IVE", "JUST", "KEEP", "KILL", "KNEW",
  "KNOW", "LAST", "LATE", "LEFT", "LESS", "LET", "LIFE", "LIKE", "LIVE", "LOL",
  "LONG", "LOOK", "LOSE", "LOST", "LOTS", "LOVE", "LOW", "MADE", "MAKE", "MAN",
  "MANY", "MATE", "MAY", "ME", "MEAN", "MORE", "MOST", "MUCH", "MUST", "MY",
  "NAH", "NEAR", "NEED", "NEW", "NEXT", "NO", "NONE", "NOPE", "NOT", "NOW",
  "OF", "OFF", "OK", "OLD", "OMG", "ON", "ONCE", "ONE", "ONLY", "OUR", "OUT",
  "OVER", "OWN", "PLS", "PLZ", "PUT", "REAL", "SAID", "SAME", "SAW", "SAY",
  "SEE", "SELF", "SHE", "SHIT", "SHOW", "SO", "SOME", "SOON", "STOP", "SUCH",
  "SURE", "TAKE", "TELL", "THAN", "THAT", "THEM", "THEN", "THEY", "THIS",
  "THUS", "TO", "TOLD", "TOO", "TOOK", "TWO", "UP", "US", "USE", "VERY",
  "WANT", "WAS", "WAY", "WE", "WELL", "WENT", "WERE", "WHAT", "WHEN", "WHO",
  "WHOM", "WHY", "WILL", "WISH", "WITH", "WONT", "WTF", "YEAH", "YEP", "YES",
  "YET", "YO", "YOU", "YOUR", "YOUVE",
]);

const TICKER_CUE =
  /\$[A-Za-z]{1,5}\b|\b(?:ticker|symbol|stock|stocks|shares?|share price|quote|equity|equities|compare|comparison|versus|vs\.?)\b/i;

// A long shouted sentence is prose, not a watchlist, so none of its uppercase
// words carry ticker signal. Short all-caps asks ("IS NVDA A BUY") and caps
// watchlists stay below the length and function-word thresholds.
function looksLikeShoutedSentence(text: string): boolean {
  const words = text.match(/[A-Za-z][A-Za-z']*/g) ?? [];
  if (words.length < 8) return false;
  const shouted = words.filter((word) => word === word.toUpperCase());
  if (shouted.length / words.length < 0.8) return false;
  const functionWords = shouted.filter(
    (word) => COMMON_WORDS.has(word) || NOT_TICKERS.has(word)
  );
  return functionWords.length / words.length >= 0.5;
}

export function resolveTickers(text: string, max = 4): string[] {
  if (!text) return [];
  const found = new Set<string>();

  const lower = text.toLowerCase();
  for (const [name, ticker] of Object.entries(NAME_TO_TICKER)) {
    const re = new RegExp(`\\b${name}\\b`, "i");
    if (re.test(lower)) found.add(ticker);
  }

  const shouted = looksLikeShoutedSentence(text);
  const cued = TICKER_CUE.test(text);
  for (const match of text.matchAll(/(\$?)\b([A-Z]{2,5})\b/g)) {
    const token = match[2];
    if (NOT_TICKERS.has(token)) continue;
    const explicit = match[1] === "$";
    if (explicit) {
      found.add(token);
      continue;
    }
    if (shouted) continue;
    if (COMMON_WORDS.has(token) && !cued) continue;
    found.add(token);
  }

  return [...found].slice(0, max);
}
