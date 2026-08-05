export type ShowcaseTicker = {
  ticker: string;
  name: string;
};

export const SHOWCASE_TICKERS: readonly ShowcaseTicker[] = [
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

export const SHOWCASE_SYMBOLS = SHOWCASE_TICKERS.map(({ ticker }) => ticker);
