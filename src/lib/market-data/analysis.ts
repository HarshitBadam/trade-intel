import "server-only";

import { z } from "zod";
import {
  GROQ_ANALYSIS_MODEL,
  hasGroq,
  hasLangflowAnalyze,
  LANGFLOW_ANALYZE_FLOW_ID,
} from "@/lib/config";
import { groqChatJSON } from "@/lib/groq";
import { runLangflowFlow } from "@/lib/langflow";
import { parseFencedJson } from "@/lib/llm-json";
import { ANALYSIS_INSTRUCTIONS } from "@/lib/stocksage/analysis-prompt";
import { rateLimit } from "@/lib/rate-limit";
import { isOpen, recordFailure, recordSuccess } from "@/lib/breaker";
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

// The deep-analysis engine (redesign §6). Given a ticker whose articles are
// already in Astra, it runs ONE LLM pass that both (a) relabels the SAME stored
// article set in place (per-article sentiment/importance/key_observations — D6:
// the gauge number refines, it doesn't jump) and (b) emits the collection-level
// verdict doc (§6 schema). Everything is grounded ONLY in stored articles — no
// live search (D19). `analyzed_at` is written ONLY on a fully successful run
// (D14 — the firm freshness fix): a dead or malformed LLM must leave the last
// known-good verdict completely intact.

const DAY_MS = 24 * 60 * 60 * 1000;

// Refresh clock (redesign §9): re-analyze when the verdict is older than this.
// Exported because Task 5 reads it to label status ("analyzed Nd ago").
export const ANALYSIS_TTL_DAYS = 3;

// Retention/analysis window (§9). Matches transforms.POPULARITY_WINDOW_DAYS so
// the verdict is built on the same 90-day population the gauge/series show.
const SOURCE_WINDOW_DAYS = 90;

// Token budget guard for the 8B model: newest N after windowing. Groq's free
// tier caps at 6,000 tokens/minute AND counts the max_tokens completion
// reservation against it, so the ceiling is (prompt + ANALYSIS_MAX_TOKENS) <
// 6,000, not just the prompt. 25 articles keeps the prompt near ~2.6k tokens;
// see ANALYSIS_MAX_TOKENS for the completion side.
const MAX_ARTICLES_PER_PASS = 25;

// Completion reservation. Kept modest because Groq bills it against the 6k TPM
// limit before the model even runs: ~2.6k prompt + 2.4k here leaves headroom
// under 6k, and 25 short article labels + the verdict need well under 2.4k.
const ANALYSIS_MAX_TOKENS = 2400;

// Trim each article's description in the prompt so a few long ones can't blow
// the budget; the title + a paragraph is plenty for a sentiment read.
const DESCRIPTION_CHARS = 300;

// One attempt per ticker per window across serverless instances (D11/§13
// single-flight), via the Upstash-with-memory-fallback rateLimit() used as a
// one-shot claim (success == this instance owns the run for the window).
const CLAIM_WINDOW_S = 10 * 60;

export type AnalyzeSummary = {
  ticker: string;
  /** Articles the verdict was built on. */
  analyzed: number;
  /** Rows whose per-article label was rewritten to "ai". */
  relabeled: number;
  verdict?: AnalysisDoc["overall_sentiment"];
  /** Set when the pass returned without writing (e.g. nothing to analyze). */
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

// ─── Freshness gate (D12) ────────────────────────────────────────────────────
// Run when: never analyzed; OR the verdict is older than the TTL; OR new
// articles arrived since the last pass (news_loaded_at > analyzed_at). Never run
// when there are zero stored articles — there is nothing to analyze. Staleness
// is judged from analyzed_at ONLY (D14), never from article dates.
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

// ─── Prompt ──────────────────────────────────────────────────────────────────

// article_id used in the prompt IS the doc `_id` (loader rows set
// article_id === _id), so validated ids map straight back to rows for the
// relabel write, and driver.article_ids cite the same identity.
type PromptArticle = {
  article_id: string;
  date: string;
  title: string;
  description: string;
};

// The instruction prompt now lives in a shared module (lib/stocksage/
// analysis-prompt.ts) so the Langflow analysis flow can embed the EXACT same
// text in its Prompt node — one source of truth for both LLM lanes (D10).
const SYSTEM_PROMPT = ANALYSIS_INSTRUCTIONS;

function buildUserPrompt(symbol: string, articles: PromptArticle[]): string {
  return [
    `Ticker: ${symbol}`,
    `Article count: ${articles.length}`,
    "Articles (JSON):",
    JSON.stringify(articles),
  ].join("\n");
}

function toPromptArticle(a: StoredArticle): PromptArticle {
  const description = (
    a.metadata.description ||
    a.page_content ||
    a.metadata.key_observations ||
    ""
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, DESCRIPTION_CHARS);
  return {
    article_id: a._id,
    date: a.metadata.publication_date ?? "",
    title: a.metadata.title ?? "Untitled",
    description,
  };
}

// ─── Response validation (zod) ───────────────────────────────────────────────
// The model returns free-form strings for the enums; we accept anything then
// normalize casing / clamp ranges ourselves, dropping only what we truly can't
// use. A run is FAILED (thrown, nothing written) when the verdict is unusable
// or >70% of the returned article labels are unusable.

const ResponseSchema = z.object({
  articles: z
    .array(
      z.object({
        article_id: z.string(),
        sentiment: z.string(),
        importance: z.string().optional(),
        key_observations: z.string().optional(),
      })
    )
    .default([]),
  verdict: z.object({
    overall_sentiment: z.string(),
    sentiment_score: z.number(),
    confidence: z.string().optional(),
    summary: z.string(),
    key_drivers: z
      .array(
        z.object({
          text: z.string(),
          sentiment: z.string().optional(),
          article_ids: z.array(z.string()).default([]),
        })
      )
      .default([]),
    risks: z.array(z.string()).default([]),
  }),
});

function normSentiment3(
  raw: string | undefined
): "Positive" | "Negative" | "Neutral" | null {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "positive":
      return "Positive";
    case "negative":
      return "Negative";
    case "neutral":
      return "Neutral";
    default:
      return null;
  }
}

function normOverall(
  raw: string
): "Positive" | "Negative" | "Neutral" | "Mixed" | null {
  if ((raw ?? "").trim().toLowerCase() === "mixed") return "Mixed";
  return normSentiment3(raw);
}

// The reader renders importance/confidence unconditionally, so these always
// resolve to a value; "Medium" is the established neutral default (providers use
// it too), so an odd label degrades gracefully rather than failing the row.
function normLevel(raw: string | undefined): "High" | "Medium" | "Low" {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "high":
      return "High";
    case "low":
      return "Low";
    default:
      return "Medium";
  }
}

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(-1, Math.min(1, n));
}

// ─── The single LLM seam (D10) ───────────────────────────────────────────────
// Langflow-first, Groq-direct-fallback (Task 6). The one place the analysis
// transport lives. It also OWNS the breaker bookkeeping for both providers so
// analyzeTicker stays transport-agnostic:
//   1. If the analysis flow is configured AND the "langflow" breaker is closed,
//      run the flow. The flow's Prompt node owns the instructions, so we send
//      ONLY the compact article payload as input and parse the returned text
//      with the SAME fence-stripping parser the direct path uses. Record
//      success/failure on "langflow".
//   2. On ANY Langflow failure (Space down, timeout, malformed, unparseable) —
//      or when Langflow isn't configured / its breaker is open — fall through to
//      the direct Groq call, whose "groq" breaker wrapping is unchanged.
// A thrown error from the Groq path propagates (a failed run writes nothing —
// the analyzed_at contract, D14). The `system` argument is used only by the
// direct path; the flow already carries the instructions internally.
async function runAnalysisLLM(system: string, user: string): Promise<unknown> {
  if (
    hasLangflowAnalyze &&
    LANGFLOW_ANALYZE_FLOW_ID &&
    !(await isOpen("langflow"))
  ) {
    try {
      const text = await runLangflowFlow({
        flowId: LANGFLOW_ANALYZE_FLOW_ID,
        input: user,
      });
      const parsed = parseFencedJson(text);
      await recordSuccess("langflow");
      return parsed;
    } catch (error) {
      await recordFailure("langflow");
      console.error(
        "[analysis] Langflow lane failed, falling back to direct Groq:",
        error
      );
    }
  }

  try {
    const raw = await groqChatJSON({
      model: GROQ_ANALYSIS_MODEL,
      system,
      user,
      maxTokens: ANALYSIS_MAX_TOKENS,
    });
    await recordSuccess("groq");
    return raw;
  } catch (error) {
    await recordFailure("groq");
    throw error;
  }
}

// ─── The engine ──────────────────────────────────────────────────────────────

export async function analyzeTicker(
  ticker: string,
  opts?: { force?: boolean }
): Promise<AnalyzeSummary> {
  const symbol = ticker.trim().toUpperCase();

  // 1) Read stored rows, keep the 90-day window, dedupe, newest-first, cap.
  const stored = await readTickerArticles(symbol, 200);
  const windowed = dedupeNews(windowNews(stored, SOURCE_WINDOW_DAYS)).slice(
    0,
    MAX_ARTICLES_PER_PASS
  ) as StoredArticle[];

  if (windowed.length === 0) {
    // Nothing to analyze — never call the LLM or write anything. `force` cannot
    // manufacture articles that don't exist.
    return { ticker: symbol, analyzed: 0, relabeled: 0, skipped: "no-articles" };
  }

  // 2) Build the one prompt from stored data only.
  const promptArticles = windowed.map(toPromptArticle);
  const sentIds = new Set(promptArticles.map((a) => a.article_id));
  const user = buildUserPrompt(symbol, promptArticles);

  // 3) Call through the single seam (Langflow-first, Groq fallback). The seam
  // owns the per-provider breaker records: a network error / rate-limit throw is
  // a provider failure that trips the relevant breaker, whereas a schema/
  // validation failure below is a content problem (not "provider down") so it
  // must not. Neither touches analyzed_at — that still rides the verdict write
  // on step 5, preserving the "analyzed_at only on success" contract (D14).
  const raw = await runAnalysisLLM(SYSTEM_PROMPT, user);

  // 4) Validate. A structurally-broken response is a FAILED run (throw).
  const parsed = ResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `analysis response failed schema validation for ${symbol}: ${parsed.error.message}`
    );
  }
  const data = parsed.data;

  // Per-article labels: keep only entries with a known id AND a usable
  // sentiment; drop the rest. If >70% of what the model returned is unusable,
  // treat the whole run as failed (no writes) — the model clearly misfired.
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
    if (seen.has(row.article_id)) continue; // ignore duplicate ids in the reply
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

  // Verdict: the collection-level fields must be usable, or the run failed.
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

  // 5) Success: relabel rows in place, THEN write the verdict with analyzed_at.
  // Order matters for D14 semantics only in that analyzed_at rides with the
  // verdict write; if that write throws, staleness is still judged off the old
  // analyzed_at (untouched).
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

// ─── Single-flight claim (one-shot rateLimit as an ownership lock) ───────────
async function claimAnalysisSlot(symbol: string): Promise<boolean> {
  const slot = await rateLimit("analysis-run", symbol, 1, CLAIM_WINDOW_S);
  return slot.success;
}

// Gate + single-flight + analyze. This is what the cron (Task 4) and the
// priority lane funnel into. Never throws: a failed pass is logged and reported
// as a status so a background loop keeps going.
export async function maybeAnalyzeTicker(
  ticker: string
): Promise<AnalysisRunStatus> {
  const symbol = ticker.trim().toUpperCase();
  if (!hasGroq) return { status: "skipped", reason: "groq-unavailable" };

  const gate = await shouldAnalyzeTicker(symbol);
  if (!gate.run) return { status: "skipped", reason: gate.reason };

  // Don't spend a claim (or a Groq call) on a provider we already know is down;
  // the cron loop treats this as a cheap skip and moves on. The breaker
  // half-opens on its own after the cooldown, so this self-heals.
  if (await isOpen("groq")) return { status: "skipped", reason: "provider-down" };

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

// ─── Priority lane (D23) ─────────────────────────────────────────────────────
// The interactive entry for a GENUINELY-COLD ticker: fires only when the store
// has nothing useful (zero articles AND no analysis doc). It first loads news
// (one Polygon call — acceptable because this lane is rare, for true cache
// misses), falling back to Alpaca news if Polygon errors, then analyzes. All
// behind the same single-flight claim. Per-user rate limiting is Task 5's job
// (this gets wrapped in a guarded server action).
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
    // Interim news / an existing verdict is good-enough on page load; let the
    // background cron do (or refresh) the deep pass.
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
