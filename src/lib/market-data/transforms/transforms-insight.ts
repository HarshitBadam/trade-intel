import type { Candidate, RelatedStock } from "../types";

export function formatVolume(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

export function moveStrength(percentChange: number): string {
  const magnitude = Math.abs(percentChange);
  if (magnitude < 1) return "Light";
  if (magnitude < 3) return "Notable";
  if (magnitude < 6) return "Strong";
  return "Heavy";
}

export function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

export function formatMarketCap(v: number | null): string {
  if (!v || v <= 0) return "";
  if (v >= 1e12) return `$${(v / 1e12).toFixed(1)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${v.toFixed(0)}`;
}

export function fmtPct(p: number): string {
  return `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`;
}

export type RelationStats = {
  ticker: string;
  price: number | null;
  pct: number | null;
  ret1y: number | null;
  volume: number | null;
  marketCap: number | null;
  sector: string | null;
};

// The lens a card is selected on, used only to bias which insight we surface,
// never to restrict it, so any card type can still lead with a divergence insight.
export type InsightLens = "industry" | "return" | "size";

type InsightGroup = "return" | "scale" | "flow" | "context";
type InsightCandidate = {
  kind: string;
  group: InsightGroup;
  salience: number;
  text: string;
};

function pctProse(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function clamp01(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function relationCandidates(
  subject: RelationStats,
  peer: RelationStats
): InsightCandidate[] {
  const out: InsightCandidate[] = [];
  const sym = subject.ticker;
  const sameSector =
    !!subject.sector &&
    !!peer.sector &&
    subject.sector.trim().toLowerCase() === peer.sector.trim().toLowerCase();

  if (subject.ret1y != null && peer.ret1y != null) {
    const gap = peer.ret1y - subject.ret1y;
    const absGap = Math.abs(gap);
    if (sameSector && absGap >= 12) {
      out.push({
        kind: "sector-divergence",
        group: "return",
        salience: clamp01(0.6 + absGap / 120, 0, 0.95),
        text: `${titleCase(peer.sector!)} peer, ${pctProse(peer.ret1y)} vs ${sym} ${pctProse(subject.ret1y)} this year`,
      });
    } else if (sameSector) {
      out.push({
        kind: "sector-tandem",
        group: "return",
        salience: 0.55,
        text: `${titleCase(peer.sector!)} peer moving with ${sym}, ${pctProse(peer.ret1y)} vs ${pctProse(subject.ret1y)}`,
      });
    }
    if (absGap >= 8) {
      const lead = gap > 0 ? "Outpacing" : "Lagging";
      out.push({
        kind: "perf-gap",
        group: "return",
        salience: clamp01(0.5 + absGap / 130, 0, 0.82),
        text: `${lead} ${sym} by ${Math.round(absGap)} points this year`,
      });
    }
  }

  if (subject.marketCap && peer.marketCap && subject.marketCap > 0 && peer.marketCap > 0) {
    const r = peer.marketCap / subject.marketCap;
    if (r >= 1.8) {
      const mult = r >= 10 ? `${Math.round(r)}\u00d7` : `${r.toFixed(1)}\u00d7`;
      out.push({
        kind: "scale",
        group: "scale",
        salience: clamp01(0.42 + Math.log(r) / Math.log(50), 0, 0.85),
        text: `Worth about ${mult} ${sym} at ${formatMarketCap(peer.marketCap)}`,
      });
    } else if (r <= 0.55) {
      const inv = 1 / r;
      const mult = inv >= 10 ? `${Math.round(inv)}\u00d7` : `${inv.toFixed(1)}\u00d7`;
      out.push({
        kind: "scale",
        group: "scale",
        salience: clamp01(0.42 + Math.log(inv) / Math.log(50), 0, 0.85),
        text: `About ${mult} smaller than ${sym} at ${formatMarketCap(peer.marketCap)}`,
      });
    } else {
      out.push({
        kind: "scale-peer",
        group: "scale",
        salience: 0.34,
        text: `Similar size to ${sym} at ${formatMarketCap(peer.marketCap)}`,
      });
    }
  }

  // Kept low: the card already shows the peer's daily % move, so this is only a
  // last resort when 1Y/sector/cap signals are unavailable.
  if (subject.pct != null && peer.pct != null) {
    const opposite = Math.sign(peer.pct) !== Math.sign(subject.pct);
    if (opposite && Math.abs(peer.pct) >= 0.4 && Math.abs(subject.pct) >= 0.4) {
      out.push({
        kind: "session",
        group: "flow",
        salience: clamp01(0.2 + (Math.abs(peer.pct) + Math.abs(subject.pct)) / 40, 0, 0.4),
        text: `Moving opposite ${sym} today, ${pctProse(peer.pct)} vs ${pctProse(subject.pct)}`,
      });
    } else if (!opposite && Math.abs(peer.pct) >= 1 && Math.abs(subject.pct) >= 1) {
      out.push({
        kind: "session",
        group: "flow",
        salience: clamp01(0.18 + (Math.abs(peer.pct) + Math.abs(subject.pct)) / 45, 0, 0.36),
        text: `Moving with ${sym} today, ${pctProse(peer.pct)} vs ${pctProse(subject.pct)}`,
      });
    }
  }

  // Also low: volume is already shown on the card.
  if (subject.volume && peer.volume && subject.volume > 0 && peer.volume > 0) {
    const r = peer.volume / subject.volume;
    if (r >= 3) {
      out.push({
        kind: "liquidity",
        group: "flow",
        salience: 0.28,
        text: `Trading about ${r >= 10 ? Math.round(r) : r.toFixed(1)}\u00d7 ${sym}'s volume today`,
      });
    } else if (r <= 1 / 3) {
      out.push({
        kind: "liquidity",
        group: "flow",
        salience: 0.24,
        text: `Lighter volume than ${sym} today`,
      });
    }
  }

  if (peer.sector) {
    out.push({
      kind: "sector-fact",
      group: "context",
      salience: 0.25,
      text: `${titleCase(peer.sector)} peer of ${sym}`,
    });
  }
  if (peer.pct != null && peer.volume != null) {
    out.push({
      kind: "anchor",
      group: "context",
      salience: 0.1,
      text: `${pctProse(peer.pct)} today on ${formatVolume(peer.volume)} shares`,
    });
  } else if (peer.price != null) {
    out.push({
      kind: "anchor",
      group: "context",
      salience: 0.1,
      text: `Trading at $${peer.price.toFixed(2)} alongside ${sym}`,
    });
  }

  return out;
}

const LENS_BOOST: Record<InsightLens, Set<string>> = {
  industry: new Set(["sector-divergence", "sector-tandem", "sector-fact"]),
  return: new Set(["perf-gap", "sector-divergence", "session"]),
  size: new Set(["scale", "scale-peer", "liquidity"]),
};

// `used` is shared across the trio of cards so no two surface the same angle.
export function buildRelationInsight(
  subject: RelationStats,
  peer: RelationStats,
  lens: InsightLens,
  used: Set<string>
): string {
  const boost = LENS_BOOST[lens];
  const scored = relationCandidates(subject, peer)
    .map((c) => ({
      ...c,
      score: c.salience + (boost.has(c.kind) ? 0.25 : 0),
    }))
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return `Peer of ${subject.ticker}`;

  const primary = scored.find((c) => !used.has(c.kind)) ?? scored[0];
  used.add(primary.kind);
  return primary.text;
}

// A peer must never be shown with invented prices; a live quote is required.
export function relatedData(
  c: Candidate & { quote: NonNullable<Candidate["quote"]> },
  reason: string
): RelatedStock {
  const pct = c.quote.percentChange;
  const up = pct >= 0;
  const sign = up ? "+" : "";

  return {
    ticker: c.ticker,
    name: c.name,
    currentPrice: `$${c.quote.price.toFixed(2)}`,
    priceChange: `${sign}${c.quote.change.toFixed(2)}`,
    percentageChange: `${sign}${pct.toFixed(2)}%`,
    volume: formatVolume(c.quote.volume),
    sentiment: up ? "Bullish" : "Bearish",
    sentimentSource: [moveStrength(pct)],
    reason,
  };
}
