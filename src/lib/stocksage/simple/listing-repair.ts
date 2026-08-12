import { z } from "zod";
import type { ChatRequest } from "../types";
import type { SubjectDatePair } from "./contracts";
import { semanticContext } from "./context";
import { simpleLlmChatJSON } from "./llm";
import { PricePairsSchema } from "./validation";

const ListingPriceRepairSchema = z.object({
  prices: PricePairsSchema,
});

export async function repairListingRelativePrices(
  request: ChatRequest,
  prices: readonly SubjectDatePair[],
  listingContext: readonly {
    name: string;
    ticker: string;
    listingDate: string;
  }[],
  now = new Date()
): Promise<SubjectDatePair[]> {
  const raw = await simpleLlmChatJSON<unknown>({
    maxTokens: 600,
    temperature: 0,
    reasoningEffort: "low",
    timeoutMs: 12_000,
    system: `You repair a financial evidence date plan after confirmed listing dates become available.
Return only {"prices":[["subject","YYYY-MM-DD"], ...]}.

Use the conversation, current message, original prices, and confirmed listing dates.
- Preserve the original subjects and their semantic order.
- Change dates only when needed to satisfy a listing-relative request such as "since IPO", "since listing", or a comparison anchored to one subject's IPO.
- For "since [company] IPO", use that company's confirmed listing date as the range start and the user's requested end date for every subject being compared.
- Emit only the range start and range end for monthly or other sampled-series requests.
- Never move a date before a confirmed listing date for that subject.
- If the user's request is not listing-relative, return the original prices unchanged.
- Do not answer the question and do not add fields.`,
    user: JSON.stringify({
      ...JSON.parse(semanticContext(request, now)),
      originalPrices: prices,
      confirmedListings: listingContext,
    }),
  });
  return ListingPriceRepairSchema.parse(raw).prices;
}
