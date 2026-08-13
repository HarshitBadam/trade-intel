import "server-only";

import { GROQ_ANALYSIS_MODEL, hasGroq } from "@/lib/config";
import { rateLimit } from "@/lib/resilience/rate-limit";
import { isOpen } from "@/lib/resilience/breaker";
import {
  applyArticleLabels,
  countTickerArticles,
  readAnalysisDoc,
  readTickerArticles,
  writeAnalysisDoc,
} from "../store";
import { dedupeNews, windowNews } from "../../transforms";
import type { AnalysisDoc, AnalysisKeyDriver, StoredArticle } from "../../types";
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

export { MAX_ARTICLES_PER_PASS };

const DAY_MS = 24 * 60 * 60 * 1000;

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
// ONLY, never from article dates, so a provider re-load that adds no new
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

export type PreparedTickerAnalysis = {
  labels: {
    _id: string;
    sentiment: string;
    importance: string;
    key_observations: string;
  }[];
  verdict: Pick<
    AnalysisDoc,
    | "overall_sentiment"
    | "sentiment_score"
    | "confidence"
    | "summary"
    | "key_drivers"
    | "risks"
    | "model"
    | "article_count"
    | "source_window_days"
  >;
};

export async function prepareTickerAnalysis(
  ticker: string,
  articles: readonly StoredArticle[]
): Promise<PreparedTickerAnalysis> {
  const symbol = ticker.trim().toUpperCase();
  const promptArticles = articles.map(toPromptArticle);
  const sentIds = new Set(promptArticles.map((article) => article.article_id));
  const raw = await runAnalysisLLM(buildUserPrompt(symbol, promptArticles));
  const parsed = ResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `analysis response failed schema validation for ${symbol}: ${parsed.error.message}`
    );
  }
  const data = parsed.data;
  const labels: PreparedTickerAnalysis["labels"] = [];
  const seen = new Set<string>();
  for (const row of data.articles) {
    const sentiment = normSentiment3(row.sentiment);
    if (!sentIds.has(row.article_id) || sentiment === null || seen.has(row.article_id)) {
      continue;
    }
    seen.add(row.article_id);
    labels.push({
      _id: row.article_id,
      sentiment,
      importance: normLevel(row.importance),
      key_observations: (row.key_observations ?? "").trim(),
    });
  }
  if (data.articles.length > 0 && labels.length / data.articles.length < 0.3) {
    throw new Error(
      `analysis returned mostly-unusable article labels for ${symbol} ` +
        `(${labels.length}/${data.articles.length} usable)`
    );
  }

  const overall = normOverall(data.verdict.overall_sentiment);
  if (overall === null || !data.verdict.summary.trim()) {
    throw new Error(`analysis returned an unusable verdict for ${symbol}`);
  }
  const keyDrivers: AnalysisKeyDriver[] = data.verdict.key_drivers
    .map((driver) => ({
      text: driver.text.trim(),
      sentiment: normSentiment3(driver.sentiment) ?? "Neutral",
      article_ids: driver.article_ids.filter((id) => sentIds.has(id)),
    }))
    .filter((driver) => driver.text.length > 0)
    .slice(0, 5);

  return {
    labels,
    verdict: {
      model: GROQ_ANALYSIS_MODEL,
      article_count: articles.length,
      overall_sentiment: overall,
      sentiment_score: clampScore(data.verdict.sentiment_score),
      confidence: normLevel(data.verdict.confidence),
      summary: data.verdict.summary.trim(),
      key_drivers: keyDrivers,
      risks: data.verdict.risks
        .map((risk) => risk.trim())
        .filter(Boolean)
        .slice(0, 3),
      source_window_days: SOURCE_WINDOW_DAYS,
    },
  };
}

export async function analyzeTicker(
  ticker: string
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

  const prepared = await prepareTickerAnalysis(symbol, windowed);
  const relabeled = await applyArticleLabels(prepared.labels);
  const analyzedAt = new Date().toISOString();
  await writeAnalysisDoc({
    ticker: symbol,
    analyzed_at: analyzedAt,
    ...prepared.verdict,
  });

  return {
    ticker: symbol,
    analyzed: windowed.length,
    relabeled,
    verdict: prepared.verdict.overall_sentiment,
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
