import "server-only";

import { GROQ_ANALYSIS_MODEL, hasGroq } from "@/lib/config";
import { rateLimit } from "@/lib/rate-limit";
import { isOpen } from "@/lib/breaker";
import {
  applyArticleLabels,
  countTickerArticles,
  readAnalysisDoc,
  readTickerArticles,
  touchNewsLoadedAt,
  upsertArticles,
  writeAnalysisDoc,
} from "./news-store";
import { fetchAlpacaNews, loadTickerNews } from "./news-loaders";
import { dedupeNews, windowNews } from "./transforms";
import type { AnalysisDoc, AnalysisKeyDriver, StoredArticle } from "./types";
import {
  ResponseSchema,
  MAX_ARTICLES_PER_PASS,
  buildUserPrompt,
  toPromptArticle,
  normSentiment3,
  normOverall,
  normLevel,
  clampScore,
  runAnalysisLLM,
} from "./analysis-helpers";

const DAY_MS = 24 * 60 * 60 * 1000;

// Exported because queries.ts reads it to label status ("analyzed Nd ago").
export const ANALYSIS_TTL_DAYS = 3;

const SOURCE_WINDOW_DAYS = 90;

// One attempt per ticker per window across serverless instances, via the
// Upstash-with-memory-fallback rateLimit() used as a one-shot claim.
const CLAIM_WINDOW_S = 10 * 60;

export type AnalyzeSummary = {
  ticker: string;
  analyzed: number;
  relabeled: number;
  verdict?: AnalysisDoc["overall_sentiment"];
  skipped?: string;
};

export type ShouldAnalyzeReason =
  | "never-analyzed"
  | "stale"
  | "new-articles"
  | "fresh"
  | "no-articles";

export type AnalysisRunStatus =
  | { status: "analyzed"; summary: AnalyzeSummary }
  | { status: "skipped"; reason: string }
  | { status: "error"; reason: string };

// Run when: never analyzed; OR the verdict is older than the TTL; OR new
// articles arrived since the last pass (news_loaded_at > analyzed_at). Never
// run when there are zero stored articles. Staleness is judged from analyzed_at
// ONLY — never from article dates — so a provider re-load that adds no new
// content doesn't force a re-run.
export async function shouldAnalyzeTicker(
  ticker: string
): Promise<{ run: boolean; reason: ShouldAnalyzeReason }> {
  const symbol = ticker.trim().toUpperCase();
  const [doc, count] = await Promise.all([
    readAnalysisDoc(symbol),
    countTickerArticles(symbol),
  ]);

  if (count === 0) return { run: false, reason: "no-articles" };
  if (!doc?.analyzed_at) return { run: true, reason: "never-analyzed" };

  const analyzedMs = Date.parse(doc.analyzed_at);
  if (Number.isNaN(analyzedMs) || Date.now() - analyzedMs > ANALYSIS_TTL_DAYS * DAY_MS) {
    return { run: true, reason: "stale" };
  }

  const loadedMs = doc.news_loaded_at ? Date.parse(doc.news_loaded_at) : NaN;
  if (!Number.isNaN(loadedMs) && loadedMs > analyzedMs) {
    return { run: true, reason: "new-articles" };
  }

  return { run: false, reason: "fresh" };
}

export async function analyzeTicker(
  ticker: string,
  opts?: { force?: boolean }
): Promise<AnalyzeSummary> {
  const symbol = ticker.trim().toUpperCase();

  const stored = await readTickerArticles(symbol, 200);
  const windowed = dedupeNews(windowNews(stored, SOURCE_WINDOW_DAYS)).slice(
    0,
    MAX_ARTICLES_PER_PASS
  ) as StoredArticle[];

  if (windowed.length === 0) {
    return { ticker: symbol, analyzed: 0, relabeled: 0, skipped: "no-articles" };
  }

  const promptArticles = windowed.map(toPromptArticle);
  const sentIds = new Set(promptArticles.map((a) => a.article_id));
  const user = buildUserPrompt(symbol, promptArticles);

  // runAnalysisLLM owns the per-provider breaker records. A network error /
  // rate-limit throw is a provider failure that trips the relevant breaker,
  // whereas a schema/validation failure below is a content problem — neither
  // touches analyzed_at, preserving the "analyzed_at only on success" contract.
  const raw = await runAnalysisLLM(user);

  const parsed = ResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `analysis response failed schema validation for ${symbol}: ${parsed.error.message}`
    );
  }
  const data = parsed.data;

  const returned = data.articles;
  const validLabels: {
    _id: string;
    sentiment: string;
    importance: string;
    key_observations: string;
  }[] = [];
  const seen = new Set<string>();
  for (const row of returned) {
    const sentiment = normSentiment3(row.sentiment);
    if (!sentIds.has(row.article_id) || sentiment === null) continue;
    if (seen.has(row.article_id)) continue;
    seen.add(row.article_id);
    validLabels.push({
      _id: row.article_id,
      sentiment,
      importance: normLevel(row.importance),
      key_observations: (row.key_observations ?? "").trim(),
    });
  }
  if (returned.length > 0 && validLabels.length / returned.length < 0.3) {
    throw new Error(
      `analysis returned mostly-unusable article labels for ${symbol} ` +
        `(${validLabels.length}/${returned.length} usable)`
    );
  }

  const overall = normOverall(data.verdict.overall_sentiment);
  if (overall === null || !data.verdict.summary.trim()) {
    throw new Error(`analysis returned an unusable verdict for ${symbol}`);
  }
  const keyDrivers: AnalysisKeyDriver[] = data.verdict.key_drivers
    .map((d) => ({
      text: d.text.trim(),
      sentiment: normSentiment3(d.sentiment) ?? "Neutral",
      article_ids: d.article_ids.filter((id) => sentIds.has(id)),
    }))
    .filter((d) => d.text.length > 0)
    .slice(0, 5);
  const risks = data.verdict.risks
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
    .slice(0, 3);

  // Success: relabel rows in place, THEN write the verdict with analyzed_at.
  // analyzed_at is written ONLY on a fully successful run (the "analyzed_at
  // only on success" contract): a dead or malformed LLM leaves the last
  // known-good verdict intact.
  const relabeled = await applyArticleLabels(validLabels);
  const analyzedAt = new Date().toISOString();
  await writeAnalysisDoc({
    ticker: symbol,
    analyzed_at: analyzedAt,
    model: GROQ_ANALYSIS_MODEL,
    article_count: windowed.length,
    overall_sentiment: overall,
    sentiment_score: clampScore(data.verdict.sentiment_score),
    confidence: normLevel(data.verdict.confidence),
    summary: data.verdict.summary.trim(),
    key_drivers: keyDrivers,
    risks,
    source_window_days: SOURCE_WINDOW_DAYS,
  });

  return {
    ticker: symbol,
    analyzed: windowed.length,
    relabeled,
    verdict: overall,
  };
}

async function claimAnalysisSlot(symbol: string): Promise<boolean> {
  const slot = await rateLimit("analysis-run", symbol, 1, CLAIM_WINDOW_S);
  return slot.success;
}

export async function maybeAnalyzeTicker(
  ticker: string
): Promise<AnalysisRunStatus> {
  const symbol = ticker.trim().toUpperCase();
  if (!hasGroq) return { status: "skipped", reason: "groq-unavailable" };

  const gate = await shouldAnalyzeTicker(symbol);
  if (!gate.run) return { status: "skipped", reason: gate.reason };

  if (await isOpen("groq-analysis")) {
    return { status: "skipped", reason: "provider-down" };
  }

  if (!(await claimAnalysisSlot(symbol))) {
    return { status: "skipped", reason: "in-flight" };
  }

  try {
    const summary = await analyzeTicker(symbol);
    return { status: "analyzed", summary };
  } catch (error) {
    console.error(`[analysis] analyze failed for ${symbol}:`, error);
    return { status: "error", reason: (error as Error).message };
  }
}

// Interactive entry for a GENUINELY-COLD ticker: fires only when the store has
// nothing useful (zero articles AND no analysis doc). Loads news (one Polygon
// call), then analyzes. All behind the same single-flight claim.
export async function requestPriorityAnalysis(
  ticker: string
): Promise<{ status: "started" | "skipped"; reason: string }> {
  const symbol = ticker.trim().toUpperCase();
  if (!hasGroq) return { status: "skipped", reason: "groq-unavailable" };

  const [count, doc] = await Promise.all([
    countTickerArticles(symbol),
    readAnalysisDoc(symbol),
  ]);
  if (count > 0 || doc) {
    return { status: "skipped", reason: "already-has-data" };
  }

  if (!(await claimAnalysisSlot(symbol))) {
    return { status: "skipped", reason: "in-flight" };
  }

  try {
    let landed = 0;
    try {
      const loaded = await loadTickerNews(symbol);
      landed = loaded.fetched;
    } catch (polygonError) {
      console.error(
        `[analysis] priority Polygon load failed for ${symbol}, trying Alpaca:`,
        polygonError
      );
      const articles = await fetchAlpacaNews(symbol);
      await upsertArticles(symbol, articles);
      await touchNewsLoadedAt(symbol);
      landed = articles.length;
    }

    if (landed === 0) return { status: "skipped", reason: "no-news-found" };

    await analyzeTicker(symbol);
    return { status: "started", reason: "analyzed" };
  } catch (error) {
    console.error(`[analysis] priority analysis failed for ${symbol}:`, error);
    return { status: "skipped", reason: (error as Error).message };
  }
}
