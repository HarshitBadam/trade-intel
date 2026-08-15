import {
  ACUTE_DISTRESS_RESPONSE,
  detectCrisis,
  detectViolenceThreat,
  SELF_HARM_RESPONSE,
  VIOLENCE_THREAT_RESPONSE,
} from "./crisis";
import {
  HIGH_STAKES_VARIANTS,
  type HighStakesKind,
} from "./high-stakes-responses";
import {
  ALL_IN,
  CASINO_OR_SPORTSBOOK,
  CODE,
  COMPANY_ANALYSIS,
  CREATIVE_ASK,
  CRYPTO,
  CRYPTO_EXECUTION,
  CRYPTO_FINANCE_CONTEXT,
  CRYPTO_PROMOTION,
  FACILITATION,
  FINANCE,
  FINANCE_ASK,
  FINANCIAL_ACTION,
  FORWARD_LOOKING,
  GAMBLING,
  GAMBLING_INSTRUCTIONS,
  GENERAL_NEWS,
  GUARANTEE,
  INVESTING_CONTEXT,
  LIFE_EVENT_STAKE,
  LOCAL_SECRET_ACCESS,
  MISCONDUCT,
  NEGATIVE_DIRECTION,
  NO_CHANCE_DOWNSIDE,
  NO_CHANCE_UPSIDE,
  PERSONAL_POSITION_DIRECTIVE,
  PREDICTION_MARKET,
  RETURN_SEEKING_PICK,
  SPORTS,
  TICKER_MENTION,
} from "./patterns";
import {
  FRUSTRATION,
  HELP,
  isCasualAcknowledgement,
  isFarewell,
  SOCIAL,
} from "./social-patterns";
import type {
  DomainPolicyDecision,
  FinanceEntity,
} from "../types";

export type { HighStakesKind };

function creativeRequestOnly(message: string): boolean {
  if (!CREATIVE_ASK.test(message)) return false;
  const remainder = message
    .split(/[.!?;\n]+|,?\s+\b(?:and|then|also|plus|btw|after that)\b\s+/i)
    .filter((clause) => clause.trim().length > 0 && !CREATIVE_ASK.test(clause))
    .join(" ");
  return !FINANCE_ASK.test(remainder);
}

function investingContext(text: string, entities: FinanceEntity[]): boolean {
  return (
    INVESTING_CONTEXT.test(text) ||
    entities.length > 0 ||
    TICKER_MENTION.test(text)
  );
}

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
    isFarewell(text) ||
    isCasualAcknowledgement(text) ||
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
