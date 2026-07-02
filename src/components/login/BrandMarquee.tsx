// Foot marquee for the login page. Keeps the kinetic "tape" energy of a markets
// site but scrolls only brand/product words — deliberately NO tickers, prices,
// or quotes, since nothing market-related should appear before the auth wall.
const WORDS = [
  "TradeIntel",
  "AI Market Intelligence",
  "Sentiment Summarized",
  "Cites Its Sources",
];

export function BrandMarquee() {
  // Duplicated so the -50% translate loops seamlessly.
  const row = [...WORDS, ...WORDS];
  return (
    <div className="login-marquee relative z-10 select-none overflow-hidden border-y border-foreground/12 dark:border-[rgba(139,123,255,0.18)]">
      <div className="login-ticker-track py-2.5">
        {row.map((word, i) => (
          <span
            key={i}
            className="mx-8 text-[11px] font-semibold uppercase tracking-[0.26em] text-muted-foreground dark:text-[#b9a9ff]"
          >
            {word}
          </span>
        ))}
      </div>
    </div>
  );
}
