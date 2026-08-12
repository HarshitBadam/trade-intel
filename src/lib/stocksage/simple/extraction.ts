import type { ChatRequest } from "../types";
import type { SimpleEvidencePlan } from "./contracts";
import { semanticContext, isoToday } from "./context";
import { simpleLlmChatJSON } from "./llm";
import { normalizeSimpleEvidencePlan } from "./validation";

export async function extractEvidencePlan(
  request: ChatRequest,
  now = new Date()
): Promise<SimpleEvidencePlan> {
  const raw = await simpleLlmChatJSON<unknown>({
    maxTokens: 800,
    temperature: 0,
    timeoutMs: 12_000,
    system: `You are the semantic extraction stage of a financial research assistant.
Return only {"prices":[["subject","YYYY-MM-DD"], ...],"news":["focused search query", ...],"rankings":[["US"|"ASX"|"UNSPECIFIED","YYYY-MM-DD"], ...]}.

The three arrays request factual evidence. Request only evidence needed to answer the user's actual question.

prices is the primary financial-evidence lane. Each entry retrieves available market prices and broad financial news for this subject at this date.
- Always include every named or conversationally referenced financial subject in prices, including when news is also populated.
- For a listed security, subject must be its canonical ticker without "$".
- For a private company, industry, concept, index, or unresolved group, use its concise canonical name. A listed price does not need to exist.
- Resolve former/latter, it/they/them, misspellings, and follow-up dates from the supplied conversation and active entities.
- Preserve the user's semantic order. Duplicate subjects are expected when multiple dates matter.
- For "doing", performance, movement, or comparison questions, emit a useful baseline date and end date for every subject.
- For an exact-date lookup, emit that date. For a period, emit its start and end.
- For monthly, quarterly, or other sampled-series requests, emit only the range start and range end for each subject. The backend samples the intervening sessions.
- For causal/current-news questions, emit the relevant period boundaries.

news is supplemental. Populate it only when the user asks about a specific named story, allegation, announcement, report, lawsuit, investigation, or event. Write a concise standalone search query. Do not use news for ordinary price, performance, comparison, "why", or general company-news questions.

rankings is only for market-wide top, bottom, best, worst, gainers, losers, or movers. The product's default ranking market is US. Use US when the user does not name a market. Use ASX only when it is explicit in the current request or was explicitly established in the supplied conversation. Ranking named companies against one another belongs in prices, not rankings.
- For a pure market-wide ranking request, leave prices empty even when the ranking includes a sector or industry qualifier. Add prices only for a separately requested named security or index.
- A general market overview, trend, or news request is not a ranking. For a general ASX or Australian share-market request, use AXJO in prices.

Examples:
- "How is Apple doing?" -> {"prices":[["AAPL","${isoToday(now)}"]],"news":[],"rankings":[]}
- "Latest general news on SpaceX" -> {"prices":[["SpaceX","${isoToday(now)}"]],"news":[],"rankings":[]}
- "What about the Macquarie whistleblower story?" -> {"prices":[["MQG","${isoToday(now)}"]],"news":["Macquarie whistleblower allegations"],"rankings":[]}
- "Rank Apple against Microsoft" -> {"prices":[["AAPL","${isoToday(now)}"],["MSFT","${isoToday(now)}"]],"news":[],"rankings":[]}
- "Top and bottom US performers today" -> {"prices":[],"news":[],"rankings":[["US","${isoToday(now)}"]]}
- "Top and bottom performers today" -> {"prices":[],"news":[],"rankings":[["US","${isoToday(now)}"]]}
- "What can you tell me about the ASX generally?" -> {"prices":[["AXJO","${isoToday(now)}"]],"news":[],"rankings":[]}

Never invent a ticker. If the request has no finance-research subject or market request, return all three arrays empty. Do not answer the question and do not add fields.`,
    user: semanticContext(request, now),
  });
  return normalizeSimpleEvidencePlan(raw);
}
