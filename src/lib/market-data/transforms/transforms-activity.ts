import type { BarPoint, News, ActivitySeries, ActivityPoint, ActivityMarker } from "../types";

// 21-day trailing window keeps the tint stable instead of flipping on one article.
const SENTIMENT_TRAIL_DAYS = 21;
const MAX_ACTIVITY_MARKERS = 40;

function sentimentValue(n: News): number {
  const s = n.metadata.sentiment;
  if (s === "Positive") return 1;
  if (s === "Negative") return -1;
  return 0;
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function buildActivitySeries(bars: BarPoint[], news: News[]): ActivitySeries {
  const sorted = [...bars]
    .map((b) => ({
      t: typeof b.date === "number" ? b.date : Date.parse(b.date),
      activity: b.trades ?? b.volume ?? 0,
      hasTrades: typeof b.trades === "number",
    }))
    .filter((b) => !Number.isNaN(b.t))
    .sort((a, b) => a.t - b.t);

  if (sorted.length === 0) {
    return { points: [], markers: [], metric: "volume" };
  }

  const metric: "trades" | "volume" = sorted.some((b) => b.hasTrades) ? "trades" : "volume";
  const firstT = sorted[0].t;
  const lastT = sorted[sorted.length - 1].t;

  const events = news
    .map((n) => {
      const raw = n.metadata.publication_date || n.metadata.ingested_at;
      const t = raw ? Date.parse(raw) : NaN;
      return { t, s: sentimentValue(n) };
    })
    .filter((e) => !Number.isNaN(e.t))
    .sort((a, b) => a.t - b.t);

  // Two-pointer trailing window for prevailing net sentiment, forward-filled
  // (carry the last non-empty value; start neutral at 0 before any news).
  const trailMs = SENTIMENT_TRAIL_DAYS * 24 * 60 * 60 * 1000;
  let lo = 0;
  let hi = 0;
  let pos = 0;
  let neg = 0;
  let carried = 0;
  const points: ActivityPoint[] = sorted.map((bar) => {
    while (hi < events.length && events[hi].t <= bar.t) {
      if (events[hi].s > 0) pos++;
      else if (events[hi].s < 0) neg++;
      hi++;
    }
    const minT = bar.t - trailMs;
    while (lo < hi && events[lo].t < minT) {
      if (events[lo].s > 0) pos--;
      else if (events[lo].s < 0) neg--;
      lo++;
    }
    const pn = pos + neg;
    if (pn > 0) carried = (pos - neg) / pn;
    return { date: bar.t, activity: bar.activity, sentiment: carried };
  });

  const dayAgg = new Map<string, { pos: number; neg: number }>();
  for (const e of events) {
    if (e.t < firstT - 24 * 60 * 60 * 1000 || e.t > lastT) continue;
    const key = dayKey(e.t);
    const agg = dayAgg.get(key) ?? { pos: 0, neg: 0 };
    if (e.s > 0) agg.pos++;
    else if (e.s < 0) agg.neg++;
    dayAgg.set(key, agg);
  }

  const markers: ActivityMarker[] = [];
  for (const [key, agg] of dayAgg) {
    let anchor = points.find((p) => dayKey(p.date) === key);
    if (anchor) {
      for (const p of points) if (dayKey(p.date) === key) anchor = p;
    } else {
      const dayStart = Date.parse(`${key}T00:00:00.000Z`);
      anchor = points.find((p) => p.date >= dayStart);
    }
    if (!anchor) continue;
    const pn = agg.pos + agg.neg;
    markers.push({
      date: anchor.date,
      activity: anchor.activity,
      sentiment: pn > 0 ? (agg.pos - agg.neg) / pn : 0,
    });
  }
  markers.sort((a, b) => a.date - b.date);
  const trimmed =
    markers.length > MAX_ACTIVITY_MARKERS
      ? markers.slice(markers.length - MAX_ACTIVITY_MARKERS)
      : markers;

  return { points, markers: trimmed, metric };
}
