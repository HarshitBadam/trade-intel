import "server-only";

import {
  expandValidCitations,
  stripTickerCitationMarkers,
  validCitationUrls,
} from "./citations";
import { unsupportedFigures } from "./figures";
import { buildChatSystemPrompt } from "./regular-prompt";
import { buildFallbackReply } from "./regular-fallback";
import { historyMessages } from "./regular-history";
import {
  coversEveryEntity,
  missingCriteria,
  opensOnSubject,
  repeatedPriorPhrase,
  violatesStyle,
} from "./regular-guards";
import type { RegularContext } from "./retrieve";
import { synthesizeWithFallback } from "./synthesis";
import type {
  ChatReply,
  ChatRequest,
  ConversationState,
  FinanceEntity,
  RouteDecision,
} from "./types";

export type FinanceAnswerOptions = {
  timeframe?: string;
  criteria?: string[];
  note?: string;
};

export async function answerRegularChat(
  request: ChatRequest,
  decision: RouteDecision,
  entities: FinanceEntity[],
  state: ConversationState,
  context: RegularContext,
  options: FinanceAnswerOptions = {}
): Promise<ChatReply> {
  const live =
    context.quotes.length > 0 ||
    context.fundamentals.length > 0 ||
    context.sources.length > 0;
  if (
    !live &&
    decision.route !== "stable_finance" &&
    entities.some((entity) => /^Fortune (?:100|500)$/.test(entity.name))
  ) {
    return {
      text: "I can’t verify the current Fortune revenue ranking from a sufficiently recent source right now, and I’d rather not guess at the names or the order — the list changes every year. Ask me again shortly and I should be able to pull it.",
      citationUrls: [],
      retryable: true,
      live,
    };
  }
  try {
    const requireCitations =
      context.sources.length > 0 &&
      context.quotes.length === 0 &&
      context.fundamentals.length === 0 &&
      decision.route !== "stable_finance";
    const requireCoverage =
      decision.route === "comparison" && entities.length >= 2;
    const requestedCriteria =
      decision.route === "stable_finance"
        ? []
        : (options.criteria ?? state.criteria ?? []);
    const system = buildChatSystemPrompt({
      kind: "finance",
      entities,
      quotes: context.quotes,
      fundamentals: context.fundamentals,
      sources: context.sources,
      timeframe: options.timeframe ?? state.horizon,
      criteria: options.criteria ?? state.criteria,
      note: options.note,
      evidenceGap:
        decision.route !== "stable_finance" &&
        context.plan.queries.length > 0 &&
        !live,
    });
    const guardFigures =
      decision.route !== "stable_finance" || entities.length > 0;
    const figureCorpus = [
      system,
      ...request.history
        .filter((turn) => turn.role === "user")
        .map((turn) => turn.text),
      request.message,
    ].join("\n");
    const history = historyMessages(request);
    if (history.length > 0 && entities.length >= 2) {
      history.push({
        role: "system",
        content: `The next user message is about exactly: ${entities
          .map((entity) => entity.name)
          .join(", ")}. Answer about these and no one else, whatever the earlier turns discussed.`,
      });
    }
    const priorReplies = request.history
      .filter((turn) => turn.role === "ai")
      .slice(-3)
      .map((turn) => turn.text);
    let repetitionRejections = 0;
    const text = await synthesizeWithFallback({
      system,
      history,
      user: request.message,
      maxTokens: 700,
      temperature: 0.55,
      timeoutMs: 18_000,
      totalTimeoutMs: 24_000,
      event: "regular_synthesis",
      lane: "full",
      accept: (candidate) => {
        const sound =
          (!requireCitations ||
            validCitationUrls(candidate, context.sources).length > 0) &&
          (!requireCoverage ||
            (coversEveryEntity(candidate, entities) &&
              opensOnSubject(candidate, entities))) &&
          (!guardFigures ||
            unsupportedFigures(candidate, figureCorpus).length === 0) &&
          missingCriteria(candidate, requestedCriteria).length === 0 &&
          violatesStyle(candidate, context.sources.length > 0) === null;
        if (!sound) return false;
        if (
          repetitionRejections === 0 &&
          repeatedPriorPhrase(candidate, priorReplies, entities) !== null
        ) {
          repetitionRejections += 1;
          return false;
        }
        return true;
      },
      correction: (draft) => {
        const invented = guardFigures
          ? unsupportedFigures(draft, figureCorpus)
          : [];
        const style = violatesStyle(draft, context.sources.length > 0);
        const names = entities.map((entity) => entity.name).join(", ");
        const offSubject =
          requireCoverage && !opensOnSubject(draft, entities)
            ? `You started with the wrong companies. This question is about exactly: ${names} — nobody else. Open with one of them. `
            : "";
        const unmetCriteria = missingCriteria(draft, requestedCriteria);
        const criteriaGap =
          unmetCriteria.length > 0
            ? `The user specifically asked about ${unmetCriteria.join(
                " and "
              )}, and your draft never addressed it. Address it with the data you were given, or say plainly in one clause what you couldn't verify — do not answer a different question. `
            : "";
        const repeated = repeatedPriorPhrase(draft, priorReplies, entities);
        return `Rewrite that answer. ${offSubject}${criteriaGap}${
          invented.length > 0
            ? `These figures are not in the data you were given, so they must go: ${invented.join(", ")}. Do not replace them with other numbers from memory — state only figures present in the data, and where a figure is missing, say what you'd check instead. `
            : ""
        }${style ? `${style} ` : ""}${
          repeated
            ? `You reused near-identical wording from your earlier answers ("…${repeated}…") — same caveats, same closers. Say new things in new words this turn. `
            : ""
        }It must ${
          requireCoverage
            ? `cover every one of: ${names} — same criteria for each — and `
            : ""
        }cite the source ID like [S1] after every claim taken from SOURCES. Keep the same voice and length.`;
      },
    });
    const cleaned = stripTickerCitationMarkers(
      text,
      context.quotes.map((quote) => quote.ticker)
    ).trim();
    return {
      text: expandValidCitations(cleaned, context.sources),
      live,
      citationUrls: validCitationUrls(cleaned, context.sources),
    };
  } catch {
  }

  const fallback = buildFallbackReply(request, decision, entities, context);
  return { ...fallback, live };
}

export {
  buildFallbackReply,
  coversEveryEntity,
  historyMessages,
  opensOnSubject,
  repeatedPriorPhrase,
  violatesStyle,
};
