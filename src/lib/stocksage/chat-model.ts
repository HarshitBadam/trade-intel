import "server-only";

import { randomUUID } from "node:crypto";
import { createDeepResearchOffer } from "./deep-snapshot";
import { answerDegraded } from "./chat-heuristics";
import {
  expandValidCitations,
  stripTickerCitationMarkers,
  validCitationUrls,
} from "./citations";
import { detectCriteria } from "./conversation-attributes";
import { resolveConversationState } from "./entities";
import { unsupportedFigures } from "./figures";
import { planEvidence } from "./planning";
import {
  buildDeterministicRankingReply,
  buildFallbackReply,
} from "./regular-fallback";
import { buildUnifiedSystemPrompt } from "./regular-prompt";
import { historyMessages } from "./regular-history";
import {
  coversEveryEntity,
  creativeRequestOnly,
  hasSmuggledOffTopicTask,
  missingCriteria,
  opensOnSubject,
  performsSmuggledTask,
  repeatedPriorPhrase,
  violatesStyle,
} from "./regular-guards";
import { executeEvidencePlan, type RegularContext } from "./retrieve";
import {
  ABUSE_AT_BOT,
  CASUAL_ACKNOWLEDGEMENT,
  FAREWELL,
  FRUSTRATION,
  HELP,
  SOCIAL,
} from "./social-patterns";
import { synthesizeWithFallback } from "./synthesis";
import { logStockSage } from "./telemetry";
import type { ChatDependencies } from "./chat-shared";
import type { ChatReply, ChatRequest } from "./types";

// Everything in this file that inspects the message decides only WHAT DATA TO
// PREFETCH — never what the user meant. Meaning is resolved by the model from
// the raw conversation. A wrong guess here costs a missing or wasted fetch,
// not a wrong answer.

const TIME_OR_MARKET =
  /\b(?:latest|today|yesterday|now|current(?:ly)?|recent(?:ly)?|lately|news|update|earnings|guidance|price|trading|move[ds]?|moving|perform(?:s|ed|ing|ance)?|outlook|this (?:week|month|quarter|year)|month[- ]to[- ]date|mtd|trailing month|last (?:few days|week|month|quarter|year)|ytd|year[- ]to[- ]date|(?:a\s+)?(?:few|couple(?:\s+of)?) days (?:ago|back)|the other day|market|portfolio|nasdaq|nyse|asx|s&p|dow|fed|rates?|inflation|valuation|p\/?e|dividend|risks?|risky|volatil|rank|compare|vs\.?|versus|bigger|safer|cheaper)\b/i;

const CLEARLY_ELSEWHERE =
  /\b(?:joke|poem|essay|story|lyrics|weather|recipe|movie|music|celebrity|football|soccer|cricket|basketball|nba|nfl|afl|dating|crush|girlfriend|boyfriend|ask (?:someone|her|him|them) out|homework|python|javascript|typescript|code|script|derive|gravity|physics)\b/i;

// A refusal that still performs the task (prints the loop output, states the
// gravity formula, hands out dating advice) is the leak the audits kept
// finding. An off-topic decline needs none of these: code punctuation,
// digits, formula/output talk, or more than a couple of sentences.
const OFF_TOPIC_LEAK =
  /[=`{}]|\d|\bformula\b|\boutputs?\b|\bwould (?:print|return|be|look like|give)\b|\bderiv(?:e[sd]?|ation)\b|\bprints?\b|\bloops?\b(?!\s*(?:back|in))|\bequations?\b/i;

function leaksOffTopicWork(candidate: string): boolean {
  if (candidate.length > 320) return true;
  if (OFF_TOPIC_LEAK.test(candidate)) return true;
  const sentences = candidate
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence.trim().length > 0);
  return sentences.length > 3;
}

// Small talk has no retrieved evidence behind it, so it must not assert what
// markets are doing today ("quiet day", "seeing movement in tech").
const SOCIAL_MARKET_CLAIM =
  /\b(?:markets?|stocks?|tech|nasdaq|s&p|dow)\b[^.!?\n]{0,50}\b(?:up|down|red|green|quiet|choppy|volatile|rall(?:y(?:ing)?|ied)|sell(?:ing)?[- ]?off|surg(?:e|ing)|slid(?:e|ing)?|dropp(?:ed|ing)|climb(?:ed|ing)|mov(?:ed|ing)|movement|action)\b|\b(?:quiet|choppy|volatile|busy|wild|red|green|movement|action)\b[^.!?\n]{0,30}\b(?:markets?|stocks?|session|day)\b/i;

function isPureSocialTurn(message: string): boolean {
  // The anchored whole-message patterns (greetings, farewells,
  // acknowledgements, help) win outright — "bye for now" must not become a
  // data turn just because "now" looks like a time word.
  if (
    SOCIAL.test(message) ||
    FAREWELL.test(message) ||
    CASUAL_ACKNOWLEDGEMENT.test(message) ||
    HELP.test(message)
  ) {
    return true;
  }
  if (TIME_OR_MARKET.test(message)) return false;
  return FRUSTRATION.test(message) || ABUSE_AT_BOT.test(message);
}

// Citations are demanded only when the user is actually asking about
// something current; forcing [S#] chips onto a timeless concept answer
// produced both rejection loops and citation spam.
const FRESH_ASK =
  /\b(?:today|yesterday|latest|now|current(?:ly)?|recent(?:ly)?|lately|news|update|happening|moved?|moving|this (?:week|month|quarter|year)|month[- ]to[- ]date|mtd|trailing month|last (?:few days|week|month|quarter|year)|ytd|year[- ]to[- ]date|(?:a\s+)?(?:few|couple(?:\s+of)?) days (?:ago|back)|the other day|what(?:'?s| is) up|risks?|outlook|catalysts?)\b/i;

function emptyContext(asOf: string): RegularContext {
  return {
    quotes: [],
    fundamentals: [],
    sources: [],
    coverage: {},
    plan: {
      version: 1,
      route: "general",
      asOf,
      queries: [],
      requiredEntityIds: [],
      criteria: [],
    },
  };
}

export async function answerWithModel(
  request: ChatRequest,
  dependencies: ChatDependencies,
  startedAt: number
): Promise<ChatReply> {
  const resolution = resolveConversationState(
    request.message,
    request.state,
    request.history
  );
  const entities = resolution.entities;
  const social = isPureSocialTurn(request.message);
  const elsewhere = CLEARLY_ELSEWHERE.test(request.message);
  const smuggled = hasSmuggledOffTopicTask(request.message);
  // "Write me a haiku about nvidia's stock price" is a haiku request, not a
  // finance question — a creative task stays off-topic no matter how many
  // tickers appear inside it. Only a separate finance ask riding alongside
  // ("…then compare tesla and rivian") keeps the turn a data turn.
  const creativeOnly = creativeRequestOnly(request.message);
  // A named finance subject keeps the turn a data turn even when off-topic
  // content rides along; without one, off-topic keywords veto the fetch.
  const wantsData =
    !social &&
    !creativeOnly &&
    (entities.length > 0 ||
      (!elsewhere && TIME_OR_MARKET.test(request.message)));
  const offTopicTurn =
    !social && !wantsData && (elsewhere || smuggled || creativeOnly);
  // A sign-off deserves a human send-off, not a bare "Bye!".
  const farewellTurn = social && FAREWELL.test(request.message);
  // Finance turns that also smuggle an off-topic task ("what's 2**10? also
  // how's nvidia doing"): the finance half gets answered, the smuggled half
  // must be declined without being performed — partial leakage is the same
  // failure as full leakage.
  const blendedOffTopic = wantsData && (elsewhere || smuggled);

  // Follow-up turns ("what are the main risks", "vs amd") rarely re-name
  // their subjects, so a turn that resolved no entities of its own prefetches
  // for the conversation's active set instead — otherwise every follow-up
  // ships zero sources and precise figures go out uncited.
  const prefetchEntities =
    entities.length > 0 ? entities : resolution.state.entities;
  const plan = wantsData
    ? planEvidence({
        route: prefetchEntities.length >= 2 ? "comparison" : "current_finance",
        message: request.message,
        entities: prefetchEntities,
        state: resolution.state,
      })
    : undefined;
  const retrievalStartedAt = Date.now();
  const context = plan
    ? await executeEvidencePlan({
        plan,
        entities: prefetchEntities,
        providers: dependencies.retrievalProviders,
      })
    : emptyContext(new Date().toISOString());
  const retrievalMs = Date.now() - retrievalStartedAt;
  const live =
    context.quotes.length > 0 ||
    context.fundamentals.length > 0 ||
    context.sources.length > 0;
  const deterministicRanking = buildDeterministicRankingReply(
    request,
    prefetchEntities,
    context,
    resolution.state.horizon
  );
  if (deterministicRanking) {
    logStockSage({
      event: "request_complete",
      route: "model_finance",
      reasonCode: "deterministic_numeric_ranking",
      durationMs: Date.now() - startedAt,
      retrievalMs,
      providerCount: context.plan.queries.length,
      sourceCount: context.sources.length,
    });
    return {
      ...deterministicRanking,
      live,
      kind: "answer",
      responseId: randomUUID(),
      state: resolution.state,
    };
  }

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
  // Concept answers with no subjects and no live data may use illustrative
  // numbers; anything tied to real entities or retrieved evidence may not.
  const guardFigures = prefetchEntities.length > 0 || live;
  const requireCitations =
    live &&
    FRESH_ASK.test(request.message) &&
    context.sources.length > 0 &&
    context.quotes.length === 0 &&
    context.fundamentals.length === 0;
  const requestedCriteria = wantsData ? detectCriteria(request.message) : [];
  // A comparison that only ever discusses one side is a silent substitution,
  // not an answer — this parallels the older heuristics path's guard, which
  // was not carried over when the single-model-call path was introduced.
  const requireCoverage = wantsData && entities.length >= 2;
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
        if (
          requireCitations &&
          validCitationUrls(candidate, context.sources).length === 0
        ) {
          return reject("missing_citations");
        }
        if (offTopicTurn && leaksOffTopicWork(candidate)) {
          return reject("off_topic_leak");
        }
        // Applies to blended turns AND pure task requests (a delivered haiku
        // has no digits, so leaksOffTopicWork alone won't see it).
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
        if (requireCoverage && !opensOnSubject(candidate, entities)) {
          return reject("wrong_subject_opening");
        }
        if (requireCoverage && !coversEveryEntity(candidate, entities)) {
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
        const unmetCriteria = missingCriteria(draft, requestedCriteria);
        const repeated = repeatedPriorPhrase(draft, priorReplies, entities);
        const leaked = offTopicTurn && leaksOffTopicWork(draft);
        const blendedLeak =
          (blendedOffTopic || smuggled) && performsSmuggledTask(draft);
        const marketClaim = !wantsData && SOCIAL_MARKET_CLAIM.test(draft);
        const wrongOpening =
          requireCoverage && !opensOnSubject(draft, entities);
        const missingEntities =
          requireCoverage && !coversEveryEntity(draft, entities)
            ? entities.filter(
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
          unmetCriteria.length > 0
            ? `The user specifically asked about ${unmetCriteria.join(
                " and "
              )}, and your draft never addressed it. Address it with the data you were given, or say plainly in one clause what you couldn't verify — do not answer a different question. `
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
    const finalText = expandValidCitations(cleaned, context.sources);
    const deep =
      wantsData && live
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
    };
  } catch {
    // Every LLM lane failed or every draft failed publication checks.
    // Timeless definitional questions (P/E, dividend yield, market cap…) have
    // canned answers that beat a source dump; anything asking for current
    // facts or rankings must not get a definition instead of its answer.
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
      };
    }
    // If the retrieval step already produced verified market data, publish
    // that deterministically — the user still gets an answer, not boilerplate.
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
        responseId: randomUUID(),
        state: resolution.state,
      };
    }
    // No data either: one honest, retryable, state-preserving reply beats an
    // impersonation.
    return answerDegraded(request, startedAt);
  }
}
