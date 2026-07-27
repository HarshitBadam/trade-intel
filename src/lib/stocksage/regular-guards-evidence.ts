import type { ChatQuote } from "@/lib/market-data";
import { entityTerms, mentionsEntity } from "./regular-guards-core";
import type { EvidenceSource, FinanceEntity } from "./types";

const HEDGE_WORDS =
  /\b(?:around|about|roughly|approximately|approx\.?|typically|usually|historically|estimated?|est\.|likely|probably|somewhere (?:around|near|between)|ballpark|rough (?:estimate|figure|number)|(?:has|have) been known to|if i had to guess|i(?:'d| would) (?:estimate|guess)|give or take)\b/i;
const PERFORMANCE_CLAIM =
  /\b(?:up|down|gain(?:ed|s)?|lost|los(?:s|es)|return(?:ed|s)?|rose|risen|fell|fallen|climbed|dropped|rall(?:y|ied)|perform\w*|ytd|year[- ]to[- ]date|this year|mtd|month[- ]to[- ]date|this (?:week|month|quarter)|over the (?:last|past)|since january|annuali[sz]ed)\b/i;

function corpusPercents(corpus: string): number[] {
  return [...corpus.matchAll(/(-?\d+(?:\.\d+)?)\s*(?:%|percent\b)/gi)].map(
    (match) => Math.abs(Number.parseFloat(match[1]))
  );
}

export function hedgedEstimateClaim(
  text: string,
  corpus: string
): string | null {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);
  let percents: number[] | null = null;
  for (const sentence of sentences) {
    if (!HEDGE_WORDS.test(sentence) || !PERFORMANCE_CLAIM.test(sentence)) {
      continue;
    }
    const figures = [
      ...sentence.matchAll(
        /(\d+(?:\.\d+)?)(?:\s*(?:-|–|to)\s*(\d+(?:\.\d+)?))?\s*(?:%|percent\b)/gi
      ),
    ];
    if (figures.length === 0) continue;
    percents ??= corpusPercents(corpus);
    for (const match of figures) {
      const values = [match[1], match[2]]
        .filter((value): value is string => Boolean(value))
        .map((value) => Math.abs(Number.parseFloat(value)));
      if (
        !values.every((value) =>
          (percents ?? []).some((candidate) => Math.abs(candidate - value) <= 0.5)
        )
      ) {
        return sentence.trim().slice(0, 160);
      }
    }
  }
  return null;
}

const INVESTMENT_DIRECTION =
  /\b(?:buying opportunity|selling opportunity|buy(?:ing)? the dip|time to buy|time to sell|should buy|should sell|a buy\b|a sell\b|accumulate|dump the stock)\b/i;
const RESEARCH_CLAIM =
  /\b(?:guidance|demand|orders?|AI workloads?|rollout|launch(?:es|ed|ing)?|refresh|next[- ]gen(?:eration)?|new (?:product|chip|platform)|chip releases?|gpu makers?|supply(?: chain)?|bottlenecks?|partnership|component availability|pricing power|cap[- ]?ex|capital spending|enterprise (?:tech )?spending|antitrust|regulat(?:ion|ory|ors?|ory scrutiny)|litigation|investigation|earnings report|earnings (?:approaches|date)|adoption|market share|competitive pressure|competitors? capture|catalysts?|headwinds?|tailwinds?|technical pullback|run-up|market volatility|company-specific news|selling pressure|driving the stock|reaction to|expected to|keep(?:s|ing)? (?:expanding|growing)|(?:could|would|may|might|will|likely to) (?:boost|curb|drive|erode|impose|lift|reinforce|weigh|lead|increase|decrease|raise|reduce|support|pressure))\b/i;
const RECENCY_CLAIM =
  /\b(?:latest|recent|new|next[- ]gen(?:eration)?|upcoming|next quarter|this quarter|currently|ongoing|approaches)\b/i;
const ANALYTICAL_INFERENCE =
  /\b(?:this (?:suggests|implies|indicates)|an inference from|on that evidence|based on (?:that|these cited facts))\b/i;

function claimUnits(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((unit) => unit.trim())
    .filter(
      (unit) =>
        unit.length > 0 &&
        !/^(?:#{1,6}\s*)?(?:\*\*)?(?:bull case|bear case|risks?|catalysts?|outlook|verdict|evidence checked)(?:\*\*)?:?\s*$/i.test(
          unit
        )
    );
}

function hasValidSourceId(unit: string, sources: EvidenceSource[]): boolean {
  const ids = new Set(sources.map((source) => source.id.toUpperCase()));
  return [...unit.matchAll(/\[(S\d+)\]/gi)].some((match) =>
    ids.has(match[1].toUpperCase())
  );
}

export function uncitedResearchClaimUnits(
  text: string,
  sources: EvidenceSource[]
): string[] {
  return claimUnits(text).filter((unit) => {
    if (
      !RESEARCH_CLAIM.test(unit) &&
      !(
        RECENCY_CLAIM.test(unit) &&
        /\b(?:product|event|earnings|report|chip|development|risk|outlook)\b/i.test(
          unit
        )
      )
    ) {
      return false;
    }
    return !hasValidSourceId(unit, sources);
  });
}

export function investmentDirectionClaim(text: string): string | null {
  return claimUnits(text).find((unit) => INVESTMENT_DIRECTION.test(unit)) ?? null;
}

export function firstPersonVerificationLimitation(text: string): string | null {
  return (
    claimUnits(text).find((unit) =>
      /\bI\s+(?:couldn['’]?t|could not|can['’]?t|cannot)\s+(?:verify|confirm|find|check|pull|get)\b/i.test(
        unit
      )
    ) ?? null
  );
}

export function proxyMisrepresentation(
  text: string,
  entities: FinanceEntity[],
  quotes: ChatQuote[]
): string | null {
  const performanceFigure = /(?:[$€£]\s*\d|\d+(?:\.\d+)?\s*%)/;
  for (const quote of quotes) {
    if (!quote.proxySymbol) continue;
    const symbol = quote.proxySymbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (
      !new RegExp(`\\b${symbol}\\b`, "i").test(text) ||
      !/\b(?:ETF|ADR|proxy)\b/i.test(text)
    ) {
      return `${quote.proxySymbol} must be identified as an ETF/ADR proxy`;
    }
    const units = text.split(/(?<=[.!?])\s+|\n+/);
    const unlabeledProxyFigure = units.find(
      (unit) =>
        new RegExp(`\\b${symbol}\\b`, "i").test(unit) &&
        performanceFigure.test(unit) &&
        !new RegExp(
          `\\b${symbol}\\b[^\\n.!?]{0,90}\\b${quote.proxyKind === "adr" ? "ADR" : "ETF"} proxy\\b`,
          "i"
        ).test(unit)
    );
    if (unlabeledProxyFigure) {
      return `${quote.proxySymbol} figure must label the instrument as a ${quote.proxyKind === "adr" ? "ADR" : "ETF"} proxy in the same line`;
    }
    if (
      quote.proxyKind === "adr" &&
      !/\bnot the underlying Australian listing return\b/i.test(text)
    ) {
      return `${quote.proxySymbol} must say its return is not the underlying Australian listing return`;
    }
    if (quote.ticker === "AXJO" && quote.proxySymbol === "EWA") {
      if (
        !/\bEWA,\s+an Australian-market ETF proxy\b/i.test(text) ||
        !/\bthis is not an ASX index return\b/i.test(text) ||
        /\b(?:proxy for (?:the )?ASX|ASX proxy)\b/i.test(text)
      ) {
        return "EWA must be described as an Australian-market ETF proxy, with an explicit statement that this is not an ASX index return";
      }
    }
    const entity = entities.find((candidate) => candidate.ticker === quote.ticker);
    if (!entity) continue;
    const aliases =
      quote.ticker === "IXIC"
        ? ["nasdaq composite", "nasdaq", "ixic"]
        : quote.ticker === "GSPC"
          ? ["s&p 500", "s&p", "gspc"]
          : quote.ticker === "DJI"
            ? ["dow jones industrial average", "dow jones", "dow", "dji"]
            : quote.ticker === "AXJO"
              ? ["all ordinaries", "all ords", "asx 200", "asx", "axjo"]
              : [entity.name.toLowerCase(), quote.ticker.toLowerCase()];
    const offending = units.find((sentence) => {
      if (!performanceFigure.test(sentence) || !PERFORMANCE_CLAIM.test(sentence)) {
        return false;
      }
      const lower = sentence.toLowerCase();
      const proxyIndex = lower.indexOf(quote.proxySymbol!.toLowerCase());
      const underlyingIndex = aliases.reduce((first, alias) => {
        const index = lower.indexOf(alias);
        return index >= 0 && (first < 0 || index < first) ? index : first;
      }, -1);
      return (
        (underlyingIndex >= 0 && underlyingIndex < proxyIndex) ||
        (mentionsEntity(sentence, entity) &&
          !new RegExp(`\\b${symbol}\\b`, "i").test(sentence))
      );
    });
    if (offending) return offending.trim().slice(0, 160);
  }
  return null;
}

const CRITERION_EVIDENCE: Record<string, RegExp> = {
  performance:
    /\b(?:perform(?:ance|ed|ing)?|returns?|gain(?:ed|s)?|fell|rose|dropped|climbed|moved?|rall(?:y|ied)|slid|up|down)\b|[+-]?\d+(?:\.\d+)?%/i,
  valuation:
    /\b(?:valuation|p\/?e\b|price[- ]to[- ]earnings|multiple|valued|overvalued|undervalued|expensive|cheap|premium|discount)\b/i,
  earnings:
    /\b(?:earnings|eps\b|profit|revenue|guidance|beat|missed|quarter(?:ly)? results)\b/i,
  growth: /\b(?:growth|growing|grew|expand(?:ing|ed)?|accelerat|decelerat)\b/i,
  risk: /\b(?:risks?|risky|riskier|volatil|downside|exposure|safe(?:st|r|ty)?|defensive|cyclical|beta|concentrat)\b/i,
  dividends: /\b(?:dividends?|yields?|payouts?|buybacks?|distributions?)\b/i,
  outlook:
    /\b(?:outlook|expects?|expectations?|ahead|catalysts?|going forward|next (?:quarter|year)|bull(?:ish)? case|bear(?:ish)? case|headwinds?|tailwinds?)\b/i,
  size: /\b(?:market cap(?:itali[sz]ation)?|size|bigger|biggest|larger|largest|smaller|revenue|scale)\b/i,
};
const GAP_ADMISSION =
  /\b(?:couldn'?t|can'?t|could not|cannot|unable to|wasn'?t able to)\s+(?:verify|pull|confirm|get|find|check)\b|\bdon'?t have\b|\bno (?:current|verified|fresh|recent)\b|\bwhat i(?:'|’)?d check\b|\bwithout (?:current|verified)\b|\bcouldn'?t verify\b/i;

export function missingCriteria(text: string, criteria: string[]): string[] {
  if (GAP_ADMISSION.test(text)) return [];
  return criteria.filter((criterion) => {
    const pattern = CRITERION_EVIDENCE[criterion];
    return pattern ? !pattern.test(text) : false;
  });
}

function shingleWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\[s\d+\]/g, " ")
    .replace(/[^a-z0-9%$.]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function repeatedPriorPhrase(
  draft: string,
  priorReplies: string[],
  entities: FinanceEntity[] = []
): string | null {
  if (priorReplies.length === 0) return null;
  const entityWords = new Set(
    entities.flatMap((entity) =>
      entityTerms(entity).flatMap((term) => term.split(" "))
    )
  );
  const seen = new Set<string>();
  for (const reply of priorReplies) {
    const words = shingleWords(reply);
    for (let i = 0; i + 6 <= words.length; i += 1) {
      seen.add(words.slice(i, i + 6).join(" "));
    }
  }
  const words = shingleWords(draft);
  let hits = 0;
  for (let i = 0; i + 6 <= words.length; i += 1) {
    const slice = words.slice(i, i + 6);
    if (slice.some((word) => entityWords.has(word))) continue;
    if (!seen.has(slice.join(" "))) continue;
    hits += 1;
    if (hits >= 2) return slice.join(" ");
  }
  return null;
}
