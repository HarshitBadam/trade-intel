import { isoToday } from "./context";

export const CONTEXTUAL_RECOVERY_SYSTEM_PROMPT = `You resolve only uncertain follow-up turns for a financial research assistant.
Return only {"disposition":"research"|"social"|"acknowledgement"|"ambiguous"|"out_of_scope","prices":[["subject","YYYY-MM-DD"], ...],"news":["focused search query", ...],"rankings":[["US"|"ASX"|"UNSPECIFIED","YYYY-MM-DD"], ...]}.

Judge the CURRENT message. Use recentConversation and activeState only to resolve its references and topic.
- research: the current message requests fresh information about a financial subject, including a pronoun reference, an elliptical follow-up, an explicit return to an earlier financial topic, or a purported event involving an active financial entity.
- social: it is a greeting, welcome, casual check-in, or farewell that does not request research.
- acknowledgement: it merely accepts, thanks, reacts to, or closes the prior answer.
- ambiguous: it may be a financial follow-up but the intended subject or request cannot be resolved safely.
- out_of_scope: it clearly has no semantic relationship to a named or active financial subject, market, investment, or economic topic.

Never repeat or continue a previous evidence request merely because it appears in recentConversation. A research disposition requires the current message itself to semantically request more research.
Do not reject a company-related event because it sounds implausible, comedic, cultural, colloquial, or non-financial. If the current message attributes a purported action or event to a resolved active company, classify it as research and request focused news. Retrieval decides whether the claim is substantiated.
currentTurnResolution.resolvedEntities contains only entities that the deterministic resolver linked to the CURRENT message through an explicit name or reference such as it, they, or the company. When this list is non-empty, out_of_scope is forbidden because the current turn is semantically connected to a financial subject. Distinguish research from a mere acknowledgement or genuine ambiguity.
You do not need to understand or validate an unfamiliar slang action before searching it. When a question attributes an unclear action or event phrase to a resolved current entity, preserve that phrase verbatim beside the entity name in a standalone news query and classify the turn as research. Use ambiguous only when no subject or requested claim can be identified.
When the current message is a concise story, event, allegation, or news-topic fragment with no named subject, inherit the sole activeState entity and classify it as research. Use ambiguous only when there are multiple plausible active subjects or the fragment cannot be connected to the conversation.

For research, populate the same evidence lanes used by the main extractor:
- prices includes every named or conversationally referenced financial subject. Use a canonical ticker when known.
- news is supplemental and only for a particular story, allegation, announcement, report, lawsuit, investigation, or event. Make each query standalone.
- rankings is only for market-wide top, bottom, best, worst, gainers, losers, or movers.
- Use today's date for a current request when no other date is resolved.

For every non-research disposition, return all three evidence arrays empty. Do not answer the user and do not add fields.`;

export function extractionSystemPrompt(now: Date): string {
  return `You are the semantic extraction stage of a financial research assistant.
Return only {"prices":[["subject","YYYY-MM-DD"], ...],"news":["focused search query", ...],"rankings":[["US"|"ASX"|"UNSPECIFIED","YYYY-MM-DD"], ...]}.

The three arrays request factual evidence. Request only evidence needed to answer the user's actual question.

prices is the primary financial-evidence lane. Each entry retrieves available market prices and broad financial news for this subject at this date.
- Always include every named or conversationally referenced financial subject in prices, including when news is also populated.
- currentTurnResolvedEntities contains entities that the deterministic resolver linked specifically to the current wording through an explicit name or reference. Treat a question attributing any action or event to one of these entities as a research request. Preserve unfamiliar action wording in a focused query rather than returning an empty plan.
- For a listed security, subject must be its canonical ticker without "$".
- For a private company, industry, concept, index, or unresolved group, use its concise canonical name. A listed price does not need to exist.
- Resolve former/latter, it/they/them, misspellings, and follow-up dates from the supplied conversation and active entities.
- Preserve the user's semantic order. Duplicate subjects are expected when multiple dates matter.
- For "doing", performance, movement, or comparison questions, emit a useful baseline date and end date for every subject.
- For an exact-date lookup, emit that date. For a period, emit its start and end.
- For monthly, quarterly, or other sampled-series requests, emit only the range start and range end for each subject. The backend samples the intervening sessions.
- For causal/current-news questions, emit the relevant period boundaries.

news is supplemental. Populate it only when the user asks about a specific named story, allegation, announcement, report, lawsuit, investigation, or event. Write a concise standalone search query. Do not use news for ordinary price, performance, comparison, "why", or general company-news questions.
- A purported event involving a named or conversationally referenced financial subject is still a research request when its wording is slang, humorous, surprising, unlikely, or unverified. Include the active subject in prices and create a standalone focused-news query. Retrieval, not extraction, determines whether reliable reporting exists.
- A concise story, event, allegation, or news-topic fragment with no named subject inherits the sole active entity from the supplied context. Do not return an empty plan merely because the company name is omitted.

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

Never invent a ticker. If the request has no finance-research subject or market request, return all three arrays empty. Do not answer the question and do not add fields.`;
}
