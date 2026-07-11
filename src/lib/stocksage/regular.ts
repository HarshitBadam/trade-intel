import "server-only";

import { GROQ_CHAT_MODEL, hasGroq } from "@/lib/config";
import { isOpen, recordFailure, recordSuccess } from "@/lib/breaker";
import { groqChatText } from "@/lib/groq";
import { expandValidCitations, validCitationUrls } from "./citations";
import { buildRegularSystemPrompt } from "./regular-prompt";
import type { RegularContext } from "./retrieve";
import type {
  ChatReply,
  ChatRequest,
  ConversationState,
  FinanceEntity,
  RouteDecision,
} from "./types";

export function buildFallbackReply(
  request: ChatRequest,
  decision: RouteDecision,
  entities: FinanceEntity[],
  context: RegularContext
): Pick<ChatReply, "text" | "citationUrls"> {
  const lines: string[] = [];
  if (context.quotes.length > 0) {
    lines.push("Validated market data:");
    for (const quote of context.quotes) {
      const sign = quote.dayPct >= 0 ? "+" : "";
      lines.push(
        `- **${quote.ticker}**: $${quote.price.toFixed(2)}, ${sign}${quote.dayPct.toFixed(2)}% for the session, as of ${quote.asOf}.`
      );
    }
  }
  if (context.sources.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Relevant reporting is available:");
    for (const source of context.sources.slice(0, 3)) {
      const names = source.entityIds
        .map((id) => entities.find((entity) => entity.id === id)?.name)
        .filter(Boolean)
        .join(", ");
      lines.push(
        `- ${names || "The requested topic"}: ${source.outlet}${
          source.publishedAt ? ` (${source.publishedAt})` : ""
        } [${source.id}]`
      );
    }
  }
  if (decision.route === "comparison") {
    if (lines.length > 0) lines.push("");
    lines.push("Comparable verified data is incomplete:");
    for (const entity of entities) {
      const quote = context.quotes.find(
        (candidate) => candidate.ticker === entity.ticker
      );
      lines.push(
        quote
          ? `- **${entity.name}**: price and return data shown above.`
          : `- **${entity.name}**: comparable validated data is unavailable.`
      );
    }
  }
  if (
    decision.route === "stable_finance" &&
    /\b(?:p\/?e|price[- ]to[- ]earnings)\b/i.test(request.message)
  ) {
    return {
      text: "A P/E ratio is a company’s share price divided by its earnings per share. It shows how much investors are paying for each dollar of earnings; compare it with similar companies and consider growth, earnings quality, and debt.",
      citationUrls: [],
    };
  }
  if (lines.length === 0) {
    return {
      text:
        decision.route === "current_finance" ||
        decision.route === "comparison"
          ? "I couldn’t verify enough current, comparable evidence to answer reliably right now."
          : "I couldn’t complete that financial-market answer right now. Please try again shortly.",
      citationUrls: [],
    };
  }
  lines.push("", "The broader synthesis is temporarily unavailable.");
  const text = lines.join("\n");
  return {
    text: expandValidCitations(text, context.sources),
    citationUrls: validCitationUrls(text, context.sources),
  };
}

export async function answerRegularChat(
  request: ChatRequest,
  decision: RouteDecision,
  entities: FinanceEntity[],
  state: ConversationState,
  context: RegularContext
): Promise<ChatReply> {
  if (hasGroq && !(await isOpen("groq-chat"))) {
    try {
      const text = await groqChatText({
        model: GROQ_CHAT_MODEL,
        system: buildRegularSystemPrompt({
          route: decision.route,
          entities,
          quotes: context.quotes,
          sources: context.sources,
          history: request.history,
          state,
          coverage: context.coverage,
        }),
        user: request.message,
        maxTokens: 650,
        temperature: 0.2,
      });
      await recordSuccess("groq-chat");
      return {
        text: expandValidCitations(text, context.sources),
        live: context.quotes.length > 0 || context.sources.length > 0,
        citationUrls: validCitationUrls(text, context.sources),
      };
    } catch (error) {
      await recordFailure("groq-chat");
      console.error(
        `[stocksage] ${JSON.stringify({
          event: "synthesis_failure",
          provider: "groq-chat",
          reason: error instanceof Error ? error.name : "unknown",
        })}`
      );
    }
  }

  const fallback = buildFallbackReply(request, decision, entities, context);
  return {
    ...fallback,
    live: context.quotes.length > 0 || context.sources.length > 0,
  };
}
