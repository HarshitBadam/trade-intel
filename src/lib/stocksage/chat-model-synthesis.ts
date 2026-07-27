import { randomUUID } from "node:crypto";
import { createDeepResearchOffer } from "./deep-snapshot";
import { answerDegraded } from "./chat-heuristics";
import {
  expandValidCitations,
  stripTickerCitationMarkers,
  validCitationUrls,
} from "./citations";
import { unsupportedFigures } from "./figures";
import { planEvidence } from "./planning";
import type { StateResolution } from "./entities";
import type { ChatReply, ChatRequest } from "./types";
import type { RegularContext } from "./retrieve";
import {
  coversEveryEntity, firstPersonVerificationLimitation, hedgedEstimateClaim,
  investmentDirectionClaim, missingCriteria, opensOnSubject, performsSmuggledTask,
  proxyMisrepresentation, repeatedPriorPhrase, uncitedResearchClaimUnits, violatesStyle,
} from "./regular-guards";
import { roundFiguresForDisplay } from "./rounding";
import { buildFallbackReply } from "./regular-fallback";
import { FAREWELL } from "./social-patterns";
import { buildUnifiedSystemPrompt } from "./regular-prompt";
import { historyMessages } from "./regular-history";
import { synthesizeWithFallback } from "./synthesis";
import { logStockSage } from "./telemetry";
type SynthesisModelArgs = {
  request: ChatRequest;
  context: RegularContext;
  plan: ReturnType<typeof planEvidence> | undefined;
  prefetchEntities: StateResolution["entities"];
  entities: StateResolution["entities"];
  resolution: StateResolution;
  wantsData: boolean;
  live: boolean;
  requestedCriteria: string[];
  offTopicTurn: boolean;
  blendedOffTopic: boolean;
  smuggled: boolean;
  startedAt: number;
  retrievalMs: number;
  dataStatus: ChatReply["dataStatus"];
  farewellTurn: boolean;
};
const SOCIAL_MARKET_CLAIM = /\b(?:markets?|stocks?|tech|nasdaq|s&p|dow)\b[^.!?\n]{0,50}\b(?:up|down|red|green|quiet|choppy|volatile|rall(?:y(?:ing)?|ied)|sell(?:ing)?[- ]?off|surg(?:e|ing)|slid(?:e|ing)?|dropp(?:ed|ing)|climb(?:ed|ing)|mov(?:ed|ing)|movement|action)\b|\b(?:quiet|choppy|volatile|busy|wild|red|green|movement|action)\b[^.!?\n]{0,30}\b(?:markets?|stocks?|session|day)\b|\bgood session\b/i;
function leaksOffTopicWork(candidate: string): boolean {
  if (candidate.length > 320 || /[=`{}]|\d|\bformula\b|\boutputs?\b|\bwould (?:print|return|be|look like|give)\b|\bderiv(?:e[sd]?|ation)\b|\bprints?\b|\bloops?\b(?!\s*(?:back|in))|\bequations?\b/i.test(candidate)) return true;
  return candidate.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.trim()).length > 3;
}
function emptyContext(asOf: string): RegularContext {
  return { quotes: [], fundamentals: [], sources: [], coverage: {}, plan: { version: 1, route: "general", asOf, queries: [], requiredEntityIds: [], criteria: [] } };
}

export async function synthesizeModelAnswer(args: SynthesisModelArgs): Promise<ChatReply> {
  const { request, context, plan, prefetchEntities, entities, resolution, wantsData, live, requestedCriteria, offTopicTurn, blendedOffTopic, smuggled, startedAt, retrievalMs, dataStatus, farewellTurn } = args;
  const system = buildUnifiedSystemPrompt({
    entities: prefetchEntities,
    quotes: context.quotes,
    fundamentals: context.fundamentals,
    sources: context.sources,
    evidenceGap: Boolean(plan) && plan!.queries.length > 0 && !live,
  });
  const figureCorpus = [
    system,
    ...request.history
      .filter((turn) => turn.role === "user")
      .map((turn) => turn.text),
    request.message,
  ].join("\n");
  const guardFigures = prefetchEntities.length > 0 || live;
  const requireCitations = wantsData && context.sources.length > 0;
  const requireCoverage = wantsData && prefetchEntities.length >= 2;
  const priorReplies = request.history
    .filter((turn) => turn.role === "ai")
    .slice(-3)
    .map((turn) => turn.text);
  const synthesisStartedAt = Date.now();
  try {
    let repetitionRejections = 0;
    const text = await synthesizeWithFallback({
      system,
      history: historyMessages(request),
      user: request.message,
      maxTokens: 700,
      temperature: 0.55,
      timeoutMs: 18_000,
      totalTimeoutMs: 24_000,
      event: "regular_synthesis",
      lane: "full",
      accept: (candidate) => {
        const reject = (reason: string, detail?: string) => {
          console.error(
            `[stocksage] ${JSON.stringify({
              event: "publication_reject",
              reason,
              ...(detail ? { detail: detail.slice(0, 120) } : {}),
            })}`
          );
          return false;
        };
        const invented = guardFigures
          ? unsupportedFigures(candidate, figureCorpus)
          : [];
        if (invented.length > 0) {
          return reject("unsupported_figures", invented.join(", "));
        }
        const hedged = guardFigures
          ? hedgedEstimateClaim(candidate, figureCorpus)
          : null;
        if (hedged) return reject("hedged_estimate", hedged);
        const proxyError = proxyMisrepresentation(
          candidate,
          prefetchEntities,
          context.quotes
        );
        if (proxyError) return reject("proxy_misrepresentation", proxyError);
        const uncitedClaims = wantsData
          ? uncitedResearchClaimUnits(candidate, context.sources)
          : [];
        if (uncitedClaims.length > 0) {
          return reject("uncited_research_claims", uncitedClaims.join(" | "));
        }
        const direction = investmentDirectionClaim(candidate);
        if (direction) return reject("investment_direction", direction);
        const limitation = firstPersonVerificationLimitation(candidate);
        if (limitation) return reject("first_person_limitation", limitation);
        if (
          requireCitations &&
          validCitationUrls(candidate, context.sources).length === 0
        ) {
          return reject("missing_citations");
        }
        if (offTopicTurn && leaksOffTopicWork(candidate)) {
          return reject("off_topic_leak");
        }
        if ((blendedOffTopic || smuggled) && performsSmuggledTask(candidate)) {
          return reject("blended_off_topic_leak");
        }
        if (!wantsData && SOCIAL_MARKET_CLAIM.test(candidate)) {
          return reject("social_market_claim");
        }
        if (farewellTurn && candidate.trim().length < 20) {
          return reject("curt_farewell");
        }
        const unmet = missingCriteria(candidate, requestedCriteria);
        if (unmet.length > 0) return reject("missing_criteria", unmet.join(", "));
        if (requireCoverage && !opensOnSubject(candidate, prefetchEntities)) {
          return reject("wrong_subject_opening");
        }
        if (requireCoverage && !coversEveryEntity(candidate, prefetchEntities)) {
          return reject("incomplete_entity_coverage");
        }
        const style = violatesStyle(candidate, context.sources.length > 0);
        if (style !== null) return reject("style", style);
        if (
          repetitionRejections === 0 &&
          repeatedPriorPhrase(candidate, priorReplies, entities) !== null
        ) {
          repetitionRejections += 1;
          return reject("repeated_prior_phrase");
        }
        return true;
      },
      correction: (draft) => {
        const invented = guardFigures
          ? unsupportedFigures(draft, figureCorpus)
          : [];
        const style = violatesStyle(draft, context.sources.length > 0);
        const hedged = guardFigures
          ? hedgedEstimateClaim(draft, figureCorpus)
          : null;
        const proxyError = proxyMisrepresentation(
          draft,
          prefetchEntities,
          context.quotes
        );
        const uncitedClaims = wantsData
          ? uncitedResearchClaimUnits(draft, context.sources)
          : [];
        const direction = investmentDirectionClaim(draft);
        const limitation = firstPersonVerificationLimitation(draft);
        const unmetCriteria = missingCriteria(draft, requestedCriteria);
        const repeated = repeatedPriorPhrase(draft, priorReplies, entities);
        const leaked = offTopicTurn && leaksOffTopicWork(draft);
        const blendedLeak =
          (blendedOffTopic || smuggled) && performsSmuggledTask(draft);
        const marketClaim = !wantsData && SOCIAL_MARKET_CLAIM.test(draft);
        const wrongOpening =
          requireCoverage && !opensOnSubject(draft, prefetchEntities);
        const missingEntities =
          requireCoverage && !coversEveryEntity(draft, prefetchEntities)
            ? prefetchEntities.filter(
                (entity) => !coversEveryEntity(draft, [entity])
              )
            : [];
        return `Rewrite that reply. ${
          leaked
            ? "This request is outside StockSage's lane. Reply with ONE friendly sentence saying so, plus at most one finance pivot. It must contain no numbers, code, outputs, formulas, derivations, advice, or any partial completion of the request itself. "
            : ""
        }${
          blendedLeak
            ? "This message asks for an off-topic task (a calculation, code, a poem/haiku/story, or similar). Never perform any of it — no result, no equation, no output, no verse or creative writing, even when the subject is a stock. If a genuine finance question rides alongside, answer that part; otherwise one friendly sentence that it's outside your lane. "
            : ""
        }${
          marketClaim
            ? "You asserted what markets or stocks are doing right now, but you have no market data in this turn — drop every claim about current market conditions and keep it purely conversational. "
            : ""
        }${
          farewellTurn && draft.trim().length < 20
            ? "That send-off was too curt — give it one warm, natural sentence that matches the user's tone, with no question or pitch. "
            : ""
        }${
          invented.length > 0
            ? `These figures are not in the data you were given, so they must go: ${invented.join(
                ", "
              )}. Do not replace them with other numbers from memory — state only figures present in the data, and where a figure is missing, say what you'd check instead. `
            : ""
        }${
          hedged
            ? `This hedged market-performance estimate is not supported by a retrieved figure and must be removed: "${hedged}". Do not replace it with a range, approximation, or remembered estimate. `
            : ""
        }${
          proxyError
            ? `You misrepresented proxy data: "${proxyError}". Name the ETF/ADR symbol, call it a proxy, and attribute every price and return to that ETF/ADR — never to the requested index or local listing. `
            : ""
        }${
          uncitedClaims.length > 0
            ? `These current research claim units have no valid citation in their own sentence or bullet. Add the supporting [S#] to each unit, explicitly frame a cited inference, or remove the unit: ${uncitedClaims
                .map((unit) => `"${unit}"`)
                .join(" | ")}. A citation in another bullet does not count. `
            : ""
        }${
          direction
            ? `Remove this investment-direction language: "${direction}". Describe the evidence neutrally; do not call a move a buying or selling opportunity. `
            : ""
        }${
          limitation
            ? `Replace this first-person limitation with neutral gap wording: "${limitation}". For example: "Current guidance was not present in the available reporting." `
            : ""
        }${
          unmetCriteria.length > 0
            ? `The user specifically asked about ${unmetCriteria.join(
                " and "
              )}, and your draft never addressed it. Address it with the data you were given, or use one neutral clause naming what was not present in the available reporting — do not answer a different question. `
            : ""
        }${
          wrongOpening
            ? `You opened with the wrong subject. This turn is about exactly: ${entities
                .map((entity) => entity.name)
                .join(", ")} — open with one of them, not something else. `
            : ""
        }${
          missingEntities.length > 0
            ? `You dropped ${missingEntities
                .map((entity) => entity.name)
                .join(
                  ", "
                )} entirely. Cover every one of ${entities
                .map((entity) => entity.name)
                .join(", ")} with the same criteria, or name the specific gap for whichever one you lack data on — never just omit it. `
            : ""
        }${style ? `${style} ` : ""}${
          repeated
            ? `You reused near-identical wording from your earlier answers ("…${repeated}…") — say new things in new words this turn. `
            : ""
        }${
          requireCitations
            ? "Cite the source ID like [S1] after every claim taken from SOURCES. "
            : ""
        }Output only the final reply — never apologize for or mention the rewrite, this instruction, or the earlier draft. Keep the same voice and length.`;
      },
    });
    const synthesisMs = Date.now() - synthesisStartedAt;
    const cleaned = stripTickerCitationMarkers(
      text,
      context.quotes.map((quote) => quote.ticker)
    ).trim();
    const citationUrls = validCitationUrls(cleaned, context.sources);
    const finalText = roundFiguresForDisplay(
      expandValidCitations(cleaned, context.sources)
    );
    const deep =
      wantsData
        ? createDeepResearchOffer({
            question: request.message,
            reply: { text: finalText, live, citationUrls },
            entities: prefetchEntities,
            state: resolution.state,
            sources: context.sources,
            asOf: context.plan.asOf,
          })
        : { responseId: randomUUID() };
    logStockSage({
      event: "request_complete",
      route: wantsData ? "model_finance" : "model_conversational",
      reasonCode: "single_model_call",
      durationMs: Date.now() - startedAt,
      retrievalMs,
      synthesisMs,
      providerCount: context.plan.queries.length,
      sourceCount: context.sources.length,
    });
    return {
      text: finalText,
      live,
      kind: "answer",
      citationUrls,
      responseId: deep.responseId,
      deepResearch: deep.offer,
      state: resolution.state,
      dataStatus,
    };
  } catch {
    const definitional =
      /\b(?:what(?:'?s| is| are| does)|explain|define|mean[s]?|how (?:do(?:es)?|is|are) .{0,40}(?:work|calculated|defined|measured))\b/i.test(
        request.message
      ) && !/\b(?:top|rank|largest|biggest|best|list|who)\b/i.test(request.message);
    const concept = definitional
      ? buildFallbackReply(
          request,
          {
            route: "stable_finance",
            reasonCode: "degraded_concept",
            retrievalRequired: false,
            deepEligible: false,
          },
          entities,
          emptyContext(context.plan.asOf)
        )
      : { retryable: true as const, text: "", citationUrls: [] };
    if (!concept.retryable) {
      logStockSage({
        event: "request_complete",
        route: "stable_finance",
        reasonCode: "degraded_concept",
        durationMs: Date.now() - startedAt,
        providerCount: 0,
      });
      return {
        ...concept,
        live: false,
        kind: "answer",
        responseId: randomUUID(),
        state: resolution.state,
        dataStatus: "full",
      };
    }
    if (live) {
      const fallback = buildFallbackReply(
        request,
        {
          route: prefetchEntities.length >= 2 ? "comparison" : "current_finance",
          reasonCode: "degraded_from_data",
          retrievalRequired: true,
          deepEligible: false,
        },
        prefetchEntities,
        context
      );
      const citationUrls = fallback.citationUrls ?? [];
      const deep = wantsData
        ? createDeepResearchOffer({
            question: request.message,
            reply: { text: fallback.text, live, citationUrls },
            entities: prefetchEntities,
            state: resolution.state,
            sources: context.sources,
            asOf: context.plan.asOf,
          })
        : { responseId: randomUUID() };
      logStockSage({
        event: "request_complete",
        route: "model_finance",
        reasonCode: "degraded_from_data",
        durationMs: Date.now() - startedAt,
        retrievalMs,
        providerCount: context.plan.queries.length,
        sourceCount: context.sources.length,
      });
      return {
        ...fallback,
        live,
        kind: "answer",
        responseId: deep.responseId,
        deepResearch: deep.offer,
        state: resolution.state,
        dataStatus: "limited",
      };
    }
    return {
      ...answerDegraded(request, startedAt),
      dataStatus: wantsData ? "unavailable" : "full",
    };
  }
}
