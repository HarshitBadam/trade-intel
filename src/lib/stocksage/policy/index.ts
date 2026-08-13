import {
  ACUTE_DISTRESS_RESPONSE,
  detectCrisis,
  detectViolenceThreat,
  SELF_HARM_RESPONSE,
  VIOLENCE_THREAT_RESPONSE,
} from "./crisis";
import {
  CASUAL_ACKNOWLEDGEMENT,
  FAREWELL,
  FRUSTRATION,
  HELP,
  SOCIAL,
} from "./social-patterns";
import type {
  DomainPolicyDecision,
  FinanceEntity,
} from "../types";

const CODE =
  /\b(?:python|javascript|typescript|java|c\+\+|code|script|function|loop|syntax|compile|runtime|console\.log|print\s*\(|for\s+\w+\s+in\s+range)\b/i;
const CREATIVE_ASK =
  /\b(?:write|writing|compose|pen|craft)\b[^.!?;\n]{0,40}\b(?:haikus?|poems?|poetry|songs?|raps?|stor(?:y|ies)|jokes?|limericks?|sonnets?|lyrics|ballads?|odes?|verses?)\b|\b(?:tell|give|make|do|sing)\s+(?:me\s+|us\s+)?(?:a|an|another|one more|some)\s+(?:\w+\s+){0,2}?(?:haiku|poem|song|rap|story|joke|limerick|sonnet|ballad|ode)\b|\b(?:a\s+)?(?:haiku|limerick|sonnet|ballad|ode)\s+about\b/i;
const FINANCE_ASK =
  /\b(?:how(?:'?s| is| are| did| has| have)|what(?:'?s| is| are| about| happened| moved)|compare|vs\.?|versus|rank|wb|price[sd]?|trading|perform(?:s|ed|ing|ance)?|doing|moved?|outlook|earnings|risks?)\b/i;
const SPORTS =
  /\b(?:sports?|football|soccer|cricket|rugby|basketball|baseball|tennis|afl|nfl|nba|score|fixture|match result)\b/i;
const GAMBLING =
  /\b(?:sportsbook|sports betting|betting|bet|odds|parlay|wager|casino|poker|roulette|blackjack|gambling)\b/i;
const GAMBLING_INSTRUCTIONS =
  /\b(?:picks?|tips?|strategy|system|best bet|sure bet|lock|parlay|odds|how (?:should|do) i bet|what should i bet)\b/i;
const COMPANY_ANALYSIS =
  /\b(?:public|listed|stock|shares?|company|operator|earnings|revenue|profit|margin|valuation|regulation|regulatory|balance sheet|financial performance|investment risk)\b/i;
const MISCONDUCT =
  /\b(?:insider trad(?:e|ing)|pump(?: and dump)?|dump scheme|spoof(?:ing)?|launder(?:ing)?|evade controls?|bypass controls?|fraud|deceptive promotion|market manipulation|manipulat(?:e|ing)\s+the\s+market|wash trad(?:e|ing)|drainer|steal wallets?|nonpublic information)\b/i;
const FACILITATION =
  /\b(?:help me|show me|give me|how (?:do|can|should)|steps?|plan|coordinate|execute|use|exploit|evade|bypass|steal|launder|pump|spoof|manipulate)\b/i;
const LOCAL_SECRET_ACCESS =
  /\b(?:read|open|access|show|list|print|reveal|find|cat|dump|paste|leak|expose|grab|fetch|extract|copy|run cat|echo)\b.{0,80}\b(?:\.env(?:\.local)?|env file|environment variables?|local files?|api keys?|tokens?|secrets?|credentials?|(?:tavily|groq|polygon|alpaca|finnhub|astra|upstash) key)\b/i;
const FINANCIAL_ACTION =
  /\b(?:place|execute|submit|make)\b.{0,60}\b(?:buy|sell|trade|order)\b|\b(?:buy|sell)\b.{0,60}\b(?:shares?|stocks?)\b.{0,30}\b(?:for me|on my behalf)\b|\b(?:transfer|send|move)\b.{0,60}\b(?:money|funds?|\$\s*\d)/i;
const CRYPTO =
  /\b(?:crypto|bitcoin|btc|ethereum|eth|token|memecoin|altcoin|stablecoin|blockchain|wallet|defi|nft)\b/i;

function creativeRequestOnly(message: string): boolean {
  if (!CREATIVE_ASK.test(message)) return false;
  const remainder = message
    .split(/[.!?;\n]+|,?\s+\b(?:and|then|also|plus|btw|after that)\b\s+/i)
    .filter((clause) => clause.trim().length > 0 && !CREATIVE_ASK.test(clause))
    .join(" ");
  return !FINANCE_ASK.test(remainder);
}
const CRYPTO_EXECUTION =
  /\b(?:execute|place|buy|sell|swap|transfer|send)\b.{0,50}\b(?:trade|order|crypto|bitcoin|token|wallet)|\b(?:wallet|transfer)\s+(?:steps?|instructions?)\b/i;
const CRYPTO_PROMOTION =
  /\b(?:\d{2,4}x|moon(?:shot)?|guaranteed return|guaranteed profit|pump|shill|hype|best memecoin|which (?:memecoin|altcoin)|token picks?|buy now|ape (?:in|into)|engineer hype|how (?:do|can) i buy|where (?:do|can) i buy|send (?:crypto|tokens?)|wallet instructions?)\b/i;
const CRYPTO_FINANCE_CONTEXT =
  /\b(?:market|regulation|regulatory|technology|business|company|stock|shares?|earnings|revenue|balance sheet|exposure|portfolio|risk|volatility|fund|etf|fundamental|accounting|custody|capital|liquidity|valuation)\b/i;
const FINANCE =
  /\b(?:p\/?e|price[- ]to[- ]earnings|ratio|compan(?:y|ies)|compare|ranking|equities|equity|stock|shares?|fund|etf|index|indices|fundamental|earnings|valuation|performance|momentum|outlook|risks?|returns?|market|macroeconomic|economy|inflation|rates?|commodit|bank|financial|finance|invest|portfolio|dividend|bond|yield|price|trading|nasdaq|nyse|asx|s&p|dow|fed|gdp|recession|revenue|profit|balance sheet|cash flow|big\s*(?:4|four)|fortune\s*(?:100|500))\b/i;
const GENERAL_NEWS =
  /\b(?:celebrity|gossip|movie|music|entertainment|election|politics|politician|weather|recipe|travel)\b/i;
const PREDICTION_MARKET = /\bprediction markets?\b/i;
const GUARANTEE =
  /\b(?:guarantee(?:s|d|ing)?|promis(?:e|es|ed|ing)|assur(?:e|es|ed|ing)|are you (?:sure|positive|certain)|can you (?:guarantee|promise|assure))\b.{0,90}\b(?:returns?|profits?|double|triple|\d{1,4}x|gains?|go(?:es|ing)? (?:up|down)|positive|negative|perform(?:s|ance|ing)?(?:\s+poorly|\s+well)?|money|lose|loss|year end)\b|\b(?:guaranteed|risk[- ]free|sure[- ]thing)\s+(?:returns?|profits?|picks?|stocks?|winners?)\b|\bno risk\b|\b(?:no|zero)\s+chance\b.{0,80}\b(?:fall|drop|decline|crash|lose|rise|rally|gain|go (?:up|down)|perform (?:poorly|well))\b|\bso you(?:'re| are) saying\b.{0,80}\b(?:will|won't|cannot|can't)\b.{0,30}\b(?:fall|drop|decline|crash|lose|rise|rally|gain|perform (?:poorly|well))\b/i;
const RETURN_SEEKING_PICK =
  /\b(?:which|what|pick|name|tell me|best|top|fastest|quickest|soonest)\b.{0,70}\b(?:stocks?|shares?|tickers?|investments?)\b.{0,80}\b(?:would|will|can|could|most likely to)?\b.{0,30}\b(?:double|triple|2x|3x|\d{2,4}x)\b.{0,40}\b(?:my\s+)?(?:money|returns?|profits?|gains?)\b|\b(?:double|triple|2x|3x|\d{2,4}x)\b.{0,35}\b(?:my\s+)?(?:money|returns?|profits?|gains?)\b.{0,70}\b(?:which|what|pick|stock|ticker|investment|soonest|fastest|quickest)\b/i;
const LIFE_EVENT_STAKE =
  /\b(?:sell my house|sold my house|selling my house|house (?:proceeds|money|sale)|inheritance|life savings|retirement (?:savings|fund)|superannuation|my super\b|redundancy (?:pay(?:out)?)?|mortgage refinance|divorce settlement)\b/i;
const ALL_IN =
  /\b(?:all[- ]in|everything (?:into|on|in)\b|(?:put|dump(?:ed)?|threw|poured|deposit(?:ed|ing)?|deposite(?:d|ing)?|invest(?:ed|ing)?) (?:it|them) all (?:into|on|in)\b|entire (?:savings|portfolio|position)|whole (?:savings|portfolio)|bet (?:everything|it all)|(?:one|a single) concentrated bet|remaining savings)\b/i;
const PERSONAL_POSITION_DIRECTIVE =
  /\bshould i (?:sell|buy|hold|dump|exit|double down|go all[- ]in)\b|\b(?:sell|dump)\s+(?:all\s+)?my (?:entire\s+)?(?:position|shares?|holdings?|stock)\b/i;
const CASINO_OR_SPORTSBOOK =
  /\b(?:sportsbook|casino|poker|roulette|blackjack|parlay|bookie|odds|lock)\b/i;
const INVESTING_CONTEXT =
  /\b(?:stocks?|tickers?|shares?|etfs?|index|indices|portfolio|invest(?:ing|ment)?|equit(?:y|ies)|market|returns?|profits?|positions?|holdings?|perform(?:s|ing|ance)?)\b/i;
const TICKER_MENTION =
  /(?:^|\s)\$?[A-Z]{2,5}(?:\.[A-Z]{1,3})?(?=[\s,.!?]|$)/;

function investingContext(text: string, entities: FinanceEntity[]): boolean {
  return (
    INVESTING_CONTEXT.test(text) ||
    entities.length > 0 ||
    TICKER_MENTION.test(text)
  );
}

export type HighStakesKind =
  | "guarantee_positive"
  | "guarantee_negative"
  | "life_event_past"
  | "life_event_forward"
  | "position_directive";

const HIGH_STAKES_VARIANTS: Record<HighStakesKind, string[]> = {
  guarantee_positive: [
    "I can’t guarantee any return, up or down, and you should be wary of anyone who does. Single-stock outcomes are genuinely uncertain. What I can do is lay out the current evidence, the key risks, and what would need to go right or wrong.",
    "No, I can’t promise you a positive return, and honestly nobody can. Even the strongest company can get repriced by things neither of us controls. What I can do is show you what the evidence looks like right now and where the real risks sit.",
    "I get why you want certainty here, but a promised gain isn’t something I can give you, markets just don’t offer that. The honest version is the evidence and the risk picture, and I’m happy to walk through both.",
    "If I said yes, I’d be making it up, no analyst can assure a profit on a single stock. What’s actually knowable is how the business is doing and what could push it either way, and I can take you through that.",
  ],
  guarantee_negative: [
    "I can’t promise it will do badly any more than I could promise it would do well; no evidence can guarantee either direction. What I can give you is the evidence behind the concern and what would change the thesis.",
    "No, “sure to underperform” is as much a guess as “sure to rally”. The risks I’ve flagged are real, but risks are probabilities, not verdicts. I can show you what to watch to see which way it’s actually breaking.",
    "I’m not certain of that, and I’d be lying if I claimed to be. A weak setup can still surprise on the upside. The useful thing is knowing which specific numbers would confirm or kill the bearish case, and I can lay those out.",
  ],
  life_event_past: [
    "That’s a serious amount of your life tied up in one position, so I’ll be straight with you: I can’t tell you it was the right call, and I can’t promise how it will go. Concentrating money you can’t afford to lose in a single stock is high-risk no matter the company. I can walk through the risks and what to watch, and for a decision this size it’s worth talking to a licensed financial adviser.",
    "That’s a big, real commitment you’ve already made, and I won’t pretend to know how it ends, nobody does. What matters now is understanding the position: what the company’s numbers look like, what could hurt it, and what your exit options are. For money at this scale, a licensed adviser is worth the conversation.",
    "I hear how much is riding on this. I can’t score the decision for you or forecast the outcome, a single stock carrying money you can’t afford to lose is high-risk full stop. What I can do is keep you sharp on the evidence and the warning signs, and someone licensed should be in the loop for stakes like these.",
  ],
  life_event_forward: [
    "Before you commit to that: I can’t tell you whether to do it, and I can’t promise how it would go. What I can say is that putting savings-level money into a single company would concentrate your life in one outcome, the risk compounds, it doesn’t average out. Let’s look at the evidence together, and for a decision this size a licensed financial adviser should be part of it.",
    "That’s a decision I can’t make for you, and committing money you’d genuinely miss to one stock raises the stakes a lot. No outcome here is assured in either direction. I can walk you through what the data says and what that concentration would mean, and an adviser who can see your full picture is the right person for the final call.",
    "I won’t tell you yes or no on that, it depends on your whole financial picture, which I can’t see, and there’s no guaranteed result to lean on. What I can offer is the current evidence and what a concentrated position would mean for your risk. For savings-level money, please loop in a licensed adviser.",
  ],
  position_directive: [
    "I can’t tell you to buy, sell, or hold your own position, that depends on your full finances, tax situation, and risk tolerance, which I can’t see. I can lay out the current evidence and risks so you can decide, and a licensed financial adviser can help with the personal side.",
    "That call has to stay yours, buy/sell/hold decisions hang on your whole situation, not just the stock, and I only see the stock. What I can do well is give you the evidence and the risk picture so you’re deciding with clear eyes; an adviser can handle the personal half.",
    "I don’t give personal trading instructions, not because the question’s unreasonable, but because the right answer depends on things only you (and maybe an adviser) can weigh. Happy to arm you with the data and the risks either way.",
  ],
};

const NEGATIVE_DIRECTION =
  /\b(?:poorly|badly|underperform|go(?:es|ing)?\s+down|negative|lose|loss(?:es)?|tank|drop|fall|crash|decline)\b/i;
const NO_CHANCE_DOWNSIDE =
  /\b(?:no|zero)\s+chance\b.{0,80}\b(?:fall|drop|decline|crash|lose|go down)\b/i;
const NO_CHANCE_UPSIDE =
  /\b(?:no|zero)\s+chance\b.{0,80}\b(?:rise|rally|gain|go up|perform well)\b/i;
const FORWARD_LOOKING =
  /\b(?:should|shall|can|could)\s+i\b|\bthinking (?:of|about)\b|\bplanning (?:to|on)\b|\bgoing to\b|\babout to\b|\bworth (?:putting|adding|buying)\b|\b(?:put|add|invest)\b.{0,40}\btoo\b/i;

export function classifyHighStakes(
  message: string,
  entities: FinanceEntity[]
): HighStakesKind | null {
  const text = message.trim();
  if (RETURN_SEEKING_PICK.test(text) && investingContext(text, entities)) {
    return "guarantee_positive";
  }
  if (GUARANTEE.test(text) && investingContext(text, entities)) {
    if (NO_CHANCE_DOWNSIDE.test(text)) return "guarantee_positive";
    if (NO_CHANCE_UPSIDE.test(text)) return "guarantee_negative";
    return NEGATIVE_DIRECTION.test(text)
      ? "guarantee_negative"
      : "guarantee_positive";
  }
  if (
    (LIFE_EVENT_STAKE.test(text) || ALL_IN.test(text)) &&
    investingContext(text, entities) &&
    !CASINO_OR_SPORTSBOOK.test(text)
  ) {
    return FORWARD_LOOKING.test(text) ? "life_event_forward" : "life_event_past";
  }
  if (PERSONAL_POSITION_DIRECTIVE.test(text) && !CASINO_OR_SPORTSBOOK.test(text)) {
    return "position_directive";
  }
  return null;
}

export function pickHighStakesReply(
  kind: HighStakesKind,
  used: string[]
): { id: string; text: string } {
  const pool = HIGH_STAKES_VARIANTS[kind];
  const usedSet = new Set(used);
  for (let index = 0; index < pool.length; index += 1) {
    const id = `${kind}:${index}`;
    if (!usedSet.has(id)) return { id, text: pool[index] };
  }
  const index = used.filter((id) => id.startsWith(`${kind}:`)).length % pool.length;
  return { id: `${kind}:${index}`, text: pool[index] };
}

export const OUT_OF_SCOPE_RESPONSE =
  "StockSage focuses on financial markets and public-company research. Try asking about a company, fund, market, economic trend, or finance concept.";
const scopeResponse = OUT_OF_SCOPE_RESPONSE;
const codeResponse =
  "I can’t execute or debug code here. I can help if you want to connect the question back to financial markets, a public company, or investment analysis.";
const gamblingResponse =
  "I can’t help with betting picks, odds, or gambling strategies. I can analyze a listed operator’s financial performance, regulation, or investment risks.";
const misconductResponse =
  "I can’t help facilitate financial misconduct or bypass controls. I can discuss market rules, compliance risks, or legitimate investing practices.";
const cryptoPromotionResponse =
  "I can’t provide token hype, pump calls, or guaranteed-return picks. I can discuss crypto-related market exposure, regulation, or portfolio risk.";
const cryptoExecutionResponse =
  "I can’t execute crypto trades or provide wallet and transfer instructions. I can compare market exposure, regulation, custody risks, or portfolio implications.";

const HARD_FLOOR_CODES = new Set([
  "explicit_self_harm",
  "acute_distress",
  "threat_of_violence",
  "prohibited_external_action",
  "prohibited_financial_misconduct",
  "prohibited_crypto_promotion",
  "prohibited_gambling",
  "high_stakes_finance",
]);

// Hard safety outcomes must not depend on LLM availability.
export function hardSafetyFloor(
  message: string,
  entities: FinanceEntity[]
): DomainPolicyDecision | null {
  const decision = evaluateDomainPolicy(message, entities);
  return decision.action === "respond" &&
    HARD_FLOOR_CODES.has(decision.reasonCode) &&
    decision.response
    ? decision
    : null;
}

export function evaluateDomainPolicy(
  message: string,
  entities: FinanceEntity[]
): DomainPolicyDecision {
  const text = message.trim();
  const crisis = detectCrisis(text);
  if (crisis === "self_harm") {
    return {
      action: "respond",
      reasonCode: "explicit_self_harm",
      response: SELF_HARM_RESPONSE,
    };
  }
  if (crisis === "acute_distress") {
    return {
      action: "respond",
      reasonCode: "acute_distress",
      response: ACUTE_DISTRESS_RESPONSE,
    };
  }
  if (detectViolenceThreat(text)) {
    return {
      action: "respond",
      reasonCode: "threat_of_violence",
      response: VIOLENCE_THREAT_RESPONSE,
    };
  }
  if (
    SOCIAL.test(text) ||
    HELP.test(text) ||
    (/^(?:hello|hey|hi)\b/i.test(text) &&
      /\b(?:greet|welcome)\b/i.test(text) &&
      !CODE.test(text)) ||
    FAREWELL.test(text) ||
    CASUAL_ACKNOWLEDGEMENT.test(text) ||
    FRUSTRATION.test(text)
  ) {
    return { action: "allow", reasonCode: "social" };
  }
  if (LOCAL_SECRET_ACCESS.test(text)) {
    return {
      action: "respond",
      reasonCode: "prohibited_external_action",
      response:
        "I did not and cannot access your local files, environment variables, API keys, tokens, or secrets. I can explain how to audit or rotate credentials safely.",
    };
  }
  if (FINANCIAL_ACTION.test(text)) {
    return {
      action: "respond",
      reasonCode: "prohibited_external_action",
      response:
        "I did not and cannot place that trade, access a brokerage or bank account, or transfer money. I can help you analyze the investment or explain the order before you act through your authorized provider.",
    };
  }
  if (MISCONDUCT.test(text) && FACILITATION.test(text)) {
    return {
      action: "respond",
      reasonCode: "prohibited_financial_misconduct",
      response: misconductResponse,
    };
  }
  if (CRYPTO.test(text) && CRYPTO_EXECUTION.test(text)) {
    return {
      action: "respond",
      reasonCode: "prohibited_crypto_promotion",
      response: cryptoExecutionResponse,
    };
  }
  if (CRYPTO.test(text) && CRYPTO_PROMOTION.test(text)) {
    return {
      action: "respond",
      reasonCode: "prohibited_crypto_promotion",
      response: cryptoPromotionResponse,
    };
  }
  // Gambling instructions take precedence over finance language.
  if (
    GAMBLING.test(text) &&
    !(INVESTING_CONTEXT.test(text) && !CASINO_OR_SPORTSBOOK.test(text) && !SPORTS.test(text))
  ) {
    const listedAnalysis =
      COMPANY_ANALYSIS.test(text) &&
      (entities.length > 0 || /\b(?:listed|public)\b/i.test(text));
    if (GAMBLING_INSTRUCTIONS.test(text)) {
      return {
        action: "respond",
        reasonCode: "prohibited_gambling",
        response: gamblingResponse,
      };
    }
    if (!listedAnalysis && SPORTS.test(text)) {
      return {
        action: "respond",
        reasonCode: "prohibited_gambling",
        response: gamblingResponse,
      };
    }
    if (!listedAnalysis) {
      return {
        action: "clarify",
        reasonCode: "prohibited_gambling",
        response:
          "Are you asking about a listed gambling company’s financial performance or regulatory risks? I can help with that, but not betting advice.",
      };
    }
  }
  const highStakes = classifyHighStakes(text, entities);
  if (highStakes) {
    return {
      action: "respond",
      reasonCode: "high_stakes_finance",
      response: pickHighStakesReply(highStakes, []).text,
    };
  }
  if (PREDICTION_MARKET.test(text) && !COMPANY_ANALYSIS.test(text)) {
    return {
      action: "clarify",
      reasonCode: "prohibited_gambling",
      response:
        "Are you asking about a listed prediction-market business, regulation, or financial risk? I can cover those topics, but not betting picks or strategies.",
    };
  }
  if (creativeRequestOnly(text)) {
    return {
      action: "respond",
      reasonCode: "out_of_scope",
      response:
        "I stick to financial markets and company research, so I can’t write the creative piece. I can help with the price move or market context behind the subject.",
    };
  }
  if (SPORTS.test(text) && !COMPANY_ANALYSIS.test(text)) {
    return {
      action: "respond",
      reasonCode: "out_of_scope",
      response: scopeResponse,
    };
  }
  if (CODE.test(text)) {
    return {
      action: "respond",
      reasonCode: "out_of_scope",
      response: codeResponse,
    };
  }
  if (CRYPTO.test(text)) {
    if (CRYPTO_FINANCE_CONTEXT.test(text)) {
      return { action: "allow", reasonCode: "crypto_risk_only" };
    }
    return {
      action: "clarify",
      reasonCode: "ambiguous_crypto",
      response:
        "Are you asking about crypto’s market, regulatory, business, or portfolio risks? I can help with those finance-focused angles.",
    };
  }
  if (GENERAL_NEWS.test(text)) {
    return {
      action: "respond",
      reasonCode: "out_of_scope",
      response: scopeResponse,
    };
  }
  if (entities.length > 0 || FINANCE.test(text)) {
    return { action: "allow", reasonCode: "allowed_finance" };
  }
  if (GENERAL_NEWS.test(text) || text.length > 0) {
    return {
      action: "respond",
      reasonCode: "out_of_scope",
      response: scopeResponse,
    };
  }
  return {
    action: "respond",
    reasonCode: "out_of_scope",
    response: scopeResponse,
  };
}
