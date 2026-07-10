import "server-only";

import { GROQ_CHAT_MODEL, hasGroq } from "@/lib/config";
import { isOpen, recordFailure, recordSuccess } from "@/lib/breaker";
import { groqChatText } from "@/lib/groq";
import { expandValidCitations, validCitationUrls } from "./citations";
import { buildRegularSystemPrompt } from "./regular-prompt";
import { retrieveRegularContext, type RegularContext } from "./retrieve";
import type {
  ChatIntent,
  ChatReply,
  ChatRequest,
  FinanceEntity,
} from "./types";

function safeTitle(value: string): string {
  return value.replace(/[\[\]_*`#<>]/g, "").trim();
}

function fallbackReply(
  context: RegularContext
): Pick<ChatReply, "text" | "citationUrls"> {
  const lines: string[] = [];
  if (context.quotes.length > 0) {
    lines.push("Here is the latest validated US market snapshot:");
    for (const quote of context.quotes) {
      const sign = quote.dayPct >= 0 ? "+" : "";
      lines.push(
        `- **${quote.ticker}**: $${quote.price.toFixed(2)}, ${sign}${quote.dayPct.toFixed(2)}% for the latest session.`
      );
    }
  }
  if (context.sources.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Recent relevant coverage:");
    for (const source of context.sources.slice(0, 4)) {
      lines.push(`- ${safeTitle(source.title)} [${source.id}]`);
    }
  }
  if (lines.length === 0) {
    return {
      text: "I couldn’t complete that finance answer right now. Please try again shortly.",
      citationUrls: [],
    };
  }
  lines.push("", "I couldn’t complete the full synthesis, but the verified data above is available.");
  const text = lines.join("\n");
  return {
    text: expandValidCitations(text, context.sources),
    citationUrls: validCitationUrls(text, context.sources),
  };
}

export async function answerRegularChat(
  request: ChatRequest,
  intent: ChatIntent,
  entities: FinanceEntity[]
): Promise<ChatReply> {
  const context = await retrieveRegularContext({
    message: request.message,
    intent,
    entities,
  });

  if (hasGroq && !(await isOpen("groq"))) {
    try {
      const text = await groqChatText({
        model: GROQ_CHAT_MODEL,
        system: buildRegularSystemPrompt({
          intent,
          entities,
          quotes: context.quotes,
          sources: context.sources,
          history: request.history,
        }),
        user: request.message,
        maxTokens: 1200,
        temperature: 0.2,
      });
      await recordSuccess("groq");
      return {
        text: expandValidCitations(text, context.sources),
        live: true,
        citationUrls: validCitationUrls(text, context.sources),
      };
    } catch (error) {
      await recordFailure("groq");
      console.error("[chat] Regular Groq synthesis failed:", error);
    }
  }

  const fallback = fallbackReply(context);
  return {
    ...fallback,
    live: context.quotes.length > 0 || context.sources.length > 0,
  };
}
