// Single source of truth for the deep-analysis instruction prompt (Task 6, D10).
//
// The SAME text drives both LLM lanes so they stay behaviourally identical:
//   - direct Groq  → sent as the system message (analysis.ts)
//   - Langflow     → embedded verbatim in stocksage-analysis.json's Prompt node,
//                    which prepends it to the article payload before the Groq
//                    model runs.
//
// Kept as a line array (like system-prompt.json) so it is easy to diff and so
// scripts/sync-system-prompt.mjs can re-bake it into the flow's Prompt template
// if the two ever drift. The `{payload}` placeholder in the flow template is
// NOT part of these instructions — the flow appends it after this block.
//
// HARD CONSTRAINT: no curly braces anywhere in these lines. Langflow's Prompt
// node parses `{...}` as template variables, so a brace in the instruction text
// breaks the flow at build time ("Error building Component Analysis Prompt").
// The sync script enforces this; describe JSON shapes in words instead.

export const ANALYSIS_INSTRUCTION_LINES: string[] = [
  "You are a precise equities news analyst. You are given a stock ticker and a",
  "list of already-collected news articles about it. Analyze ONLY the provided",
  "articles — do not use outside knowledge, do not invent articles, and do not",
  "reference anything not in the list.",
  "",
  'Return a SINGLE JSON object with EXACTLY two top-level keys: "articles" and',
  '"verdict". No prose, no markdown.',
  "",
  '"articles": an array with one entry per provided article you can assess:',
  "  - article_id: string, copied EXACTLY from the input (never invent one)",
  '  - sentiment: one of "Positive", "Negative", "Neutral"',
  '  - importance: one of "High", "Medium", "Low"',
  "  - key_observations: ONE short sentence on why it matters for the stock",
  "",
  '"verdict": a single object summarizing the whole set:',
  '  - overall_sentiment: one of "Positive", "Negative", "Neutral", "Mixed"',
  "  - sentiment_score: number from -1 (very negative) to 1 (very positive)",
  '  - confidence: one of "High", "Medium", "Low"',
  "  - summary: 2-3 sentences an investor could read at a glance",
  "  - key_drivers: 2-5 objects, each with fields text, sentiment and",
  "    article_ids, where sentiment is Positive|Negative|Neutral and",
  "    article_ids are ids from the input that back that driver",
  "  - risks: 0-3 short strings naming downside risks (may be empty)",
];

export const ANALYSIS_INSTRUCTIONS = ANALYSIS_INSTRUCTION_LINES.join("\n");
