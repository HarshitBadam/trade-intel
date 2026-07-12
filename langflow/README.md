# StockSage — Langflow Flows

StockSage keeps two [Langflow](https://www.langflow.org/) flow definitions
(v1.10), both backed by Groq. The analysis flow remains the optional primary
batch path with a direct-Groq fallback. The chat flow is retained as a legacy
development artifact; production chat and Research deeper now run through the
typed in-app retrieval and model-failover path.

```
                ┌──────────── Vercel (Next.js) ────────────┐
                │  deep analysis (cron / priority)         │
                └──────────────────┬────────────────────────┘
                                   │ POST /run/<analyze_id>
                                   │ fallback: Groq 8B direct
                                   ▼
                 ┌────────────────────────────────┐
                 │ stocksage-analysis.json         │
                 │ STATELESS: articles → labels    │
                 │ Groq llama-3.1-8b-instant       │
                 └──────────────────┬──────────────┘
                                    ▼
                         Next.js writes to Astra
                         (single writer, D19)
```

Both LLM lanes use **one Groq account, two models** so each lane gets its own
per-model daily bucket: 8B (roomy 14,400 RPD) for batch analysis, 70B (1,000
RPD) for interactive chat. The API key is referenced as a Langflow **global
variable** (`GROQ_API_KEY`) — never embedded in these files.

---

## Why analysis is stateless

`stocksage-analysis.json` is a **pure function**: article payload in → labels
JSON out. It does **no** Astra writes and **no** Tavily search (D19). Next.js is
the **single writer** to the store — it reads the stored articles, sends them to
the flow, validates the returned labels, and writes them back itself. Keeping the
flow write-free means the analysis lane has exactly one source of truth for the
store and the flow can be swapped or fall back to direct Groq with identical
results.

### Analysis flow contract

| | |
|---|---|
| **Input** (`input_value`) | The compact article payload the app builds: `Ticker: <SYM>`, `Article count: <N>`, `Articles (JSON): [...]`. The flow's Prompt node prepends the shared analysis instructions to it. |
| **Output** | A single JSON object (labels), extracted from the ChatOutput text and parsed with the app's fence-stripping parser. |

Output shape (abbreviated):

```json
{
  "articles": [
    { "article_id": "abc123", "sentiment": "Positive", "importance": "High",
      "key_observations": "Beat on revenue and raised guidance." }
  ],
  "verdict": {
    "overall_sentiment": "Positive", "sentiment_score": 0.6, "confidence": "High",
    "summary": "Two catalysts point up ...",
    "key_drivers": [ { "text": "Guidance raise", "sentiment": "Positive", "article_ids": ["abc123"] } ],
    "risks": ["Valuation stretched"]
  }
}
```

The **single source of truth** for the instruction text is
`src/lib/stocksage/analysis-prompt.ts`; it is embedded verbatim in the flow's
Prompt node (before the `{payload}` variable). If they ever drift, re-bake with
`node scripts/sync-system-prompt.mjs` (see below).

Flow nodes: `ChatInput-anlz1` → `AnalysisPrompt-anlz1` (Prompt Template) →
`GroqModel-anlz1` (Groq, 8B, temp 0.2, `max_tokens` 2400) → `ChatOutput-anlz1`.
`max_tokens` is deliberately bounded: Groq's free tier counts the completion
reservation against the 6,000 TPM preflight, so `prompt + 2,400 < 6,000`.

---

## `stocksage-chat.json` — legacy Deep Research flow

This flow is no longer called by the user-facing Research deeper action. It is
kept for flow development and migration reference.
The server verifies a signed immutable snapshot, reuses the same work id on
repeat requests, and sends bounded question/answer/entity context to this flow.
It answers from ingested Astra news, a **live Tavily web search**, and market
grounding. Regular chat does not call this flow.

| Node | Type | Role |
|------|------|------|
| `ChatInput-k6AeC` | Chat Input | The user message. Drives the vector search, the web search, and the prompt. |
| `AstraDB-WBI01` | Astra DB | Vector search over `prototype_db_v2`, top 8, with reranking. |
| `TavilySearchComponent-LyDPQ` | Tavily Search | **Live web search per message** (topic=general, 5 results). |
| `StockSageRagPrompt-FwmYE` | custom | Builds one grounded prompt from the question, web results, retrieved news, and the app-supplied grounding (`live_data` / `history` / `focus_tickers`). |
| `GroqModel-chat1` | **Groq** | **llama-3.3-70b-versatile** (was the Google-only Language Model node). The app injects StockSage's `system_message` via tweaks. |
| `ChatOutput-HXFDh` | Chat Output | Returns the reply. |

Edges: `ChatInput→AstraDB`, `ChatInput→Prompt`, `AstraDB→Prompt`,
`ChatInput→Tavily`, `Tavily→Prompt`, `Prompt→Groq`, `Groq→ChatOutput`. Only the
last two changed in Task 6 (LLM node swap); Astra / Tavily / Prompt wiring is
untouched.

**Grounding via tweaks.** The app sends the bounded signed-snapshot context as
`input_value` and injects market data and entity focus via `tweaks`:

| Tweak field | What the app sends |
|-------------|--------------------|
| `live_data` | Real price / % change for tickers mentioned in the turn. |
| `focus_tickers` | Tickers in scope, to keep retrieved news on-subject. |

It also tweaks the Groq node's `system_message` with StockSage's Deep Research prompt
(the Groq component derives `system_message` from `LCModelComponent`, so the
tweak path is unchanged from the old node).

---

## The breaker + fallback story

Langflow and Groq workloads have isolated circuit breakers
(`src/lib/breaker.ts`):

- **Analysis** (`src/lib/market-data/analysis.ts`): if `LANGFLOW_ANALYZE_FLOW_ID`
  is set **and** the `langflow-analysis` breaker is closed, run the flow and parse its text; on any
  failure record a breaker failure and fall through to a direct
  `groqChatJSON` on the 8B model through `groq-analysis`.
- **Deeper research** (`src/lib/stocksage/deep.ts`): broadens the typed in-app
  evidence plan and synthesizes through isolated Groq model lanes. A failure
  returns a retryable Deep Research error while preserving the regular answer.
- **Regular chat** (`src/lib/stocksage/regular.ts`): retrieves only planned
  validated context in Next.js and uses 70B, GPT OSS, then 8B synthesis lanes
  before an attributed deterministic fallback.

The transport itself lives in one place: `src/lib/langflow.ts`
(`runLangflowFlow`).

---

## Known trade-offs

- **One Tavily wrapper, different plans.** Regular chat uses bounded queries;
  Research deeper adds focused risk and fundamentals queries. Both paths filter
  results by entity, criterion, and freshness before synthesis.
- **New store rows lack vector embeddings.** Next.js now writes analysis rows
  directly (single-writer), and those rows are not embedded the way the retired
  ingestion flow embedded them. So the chat flow's vector RAG recall skews toward
  the older, embedded rows. The app's grounding block (`live_data` / `history` /
  `focus_tickers`) compensates by injecting the exact current figures regardless
  of what retrieval returns.

---

## Retired: the old Tavily→Gemini→Astra ingestion flow

An earlier version of this project ingested news via a Langflow flow (Tavily
search → Gemini extraction → Astra write). Its app-side callers were deleted
in Task 5 — Next.js now loads news itself (Polygon/Alpaca cron) and writes the
store directly — so that flow file has been removed from this directory. If
you still have it imported on your Space, delete/archive it there too: running
it would double-write article rows and burn Tavily credits for no benefit.

---

## Space setup (do this after a restart)

The Space is import-blocked while it is in the 503 "space in error" state. Once
it restarts:

1. **Restart the Space** and confirm it serves (`/health` returns OK).
2. **Global variable** (Settings → Global Variables, type *Credential*):
   `GROQ_API_KEY` = your Groq key. Both Groq nodes reference it via
   `load_from_db`. Keep `GOOGLE_API_KEY` too — Astra embeddings still use Gemini.
3. **Import `stocksage-analysis.json`** (Projects → Import).
4. **Replace / re-import `stocksage-chat.json`** (the LLM node changed to Groq).
5. Open each flow and set secrets that import blank by design. Langflow strips
   EVERY credential field on import — including the Groq nodes' global-variable
   reference — so after importing:
   - Groq node (BOTH flows) → set **API Key** to the `GROQ_API_KEY` global
     variable (pick it from the field's globe/variable selector; don't paste
     the raw key — pasting stores it in the flow data itself).
   - Astra DB node → **Astra DB Application Token**; confirm the collection shows
     `prototype_db_v2`.
   - Tavily Search node (chat flow) → **Tavily API Key**.
6. **Playground test:** run the analysis flow with a small article payload
   (expect labels JSON out); ask the chat *"How is Tesla doing?"* (expect a
   grounded, Groq-generated answer).
7. Copy each flow's id from its URL (`…/flow/<ID>`) into the app env:
   - `LANGFLOW_FLOW_ID` ← chat flow
   - `LANGFLOW_ANALYZE_FLOW_ID` ← analysis flow
   If Langflow assigned new node-id suffixes on import, the app resolves the
   chat prompt/LLM ids by prefix automatically; only set
   `LANGFLOW_CHAT_LLM_ID` / `LANGFLOW_CHAT_PROMPT_ID` to pin them if
   auto-resolution can't reach the flow.

## Re-syncing prompts

The app owns both canonical prompts. To re-bake them into these JSONs after an
edit, run:

```bash
node scripts/sync-system-prompt.mjs
```

It writes StockSage's system prompt into the chat flow's Groq `system_message`
and the analysis instructions into the analysis flow's Prompt template.

One hard rule it enforces: the analysis instructions must contain **no curly
braces**. Langflow's Prompt component parses every `{...}` in the template as a
variable, so a brace in the instruction prose breaks the flow at build time
with `Error building Component Analysis Prompt` (this bit us once — the
instructions used to say `{ text, sentiment, article_ids }`). Describe JSON
shapes in words; only `{payload}` may exist in the template.
