# Optional Langflow analysis flow

`stocksage-analysis.json` is retained only for explicit manual evaluation of
market-analysis output against the production direct-Groq path. StockSage
regular chat, Deep Research, scheduled analysis, and request-time fallbacks do
not invoke Langflow.

To evaluate it manually, configure `LANGFLOW_BASE_URL`,
`LANGFLOW_API_KEY`, and `LANGFLOW_ANALYZE_FLOW_ID`, then instantiate
`LangflowAnalysisProvider` from
`src/lib/market-data/langflow-analysis-provider.ts` in an evaluation script.
Production modules intentionally do not import that adapter.

Run `node scripts/sync-system-prompt.mjs` after changing
`src/lib/stocksage/analysis-prompt.ts`; it updates the Prompt node in the
retained analysis flow. The removed chat flow and keep-warm workflow must not
be reintroduced as production dependencies.
