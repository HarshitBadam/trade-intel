import type {
  DomainPolicyDecision,
  FinanceEntity,
} from "./types";

const SOCIAL =
  /^(?:(?:hey|hi|hello|hiya|howdy|sup|g'?day|good\s+(?:morning|afternoon|evening))(?:\s+again)?(?:,\s*i'?m back)?(?:\s+(?:boss|bro|mate|dude|there|sage|stocksage))?|i'?m back|how are you|how'?s it going|what'?s up|nice to meet you|aight(?:\s+gucci)?(?:\s+then)?|cool|sounds good|okay|ok|thanks|thank you|cheers|much appreciated|that helps|got it|gotcha|help|help me|what can you(?: actually)? (?:do|help me with)|how can you help)[\s,.!?…-]*$/i;
const FAREWELL =
  /^(?:bye|goodbye|see you)(?:[\s,]+(?:for now|later|soon|again|then|boss|bro|mate|dude|thanks|thank you))*[\s,.!?…-]*$/i;
const SELF_HARM =
  /\b(?:kill myself|end my life|want to die|suicid(?:e|al)|hurt myself|self[- ]harm|not worth living)\b/i;
const CODE =
  /\b(?:python|javascript|typescript|java|c\+\+|code|script|function|loop|syntax|compile|runtime|console\.log|print\s*\(|for\s+\w+\s+in\s+range)\b/i;
const SPORTS =
  /\b(?:sports?|football|soccer|cricket|rugby|basketball|baseball|tennis|afl|nfl|nba|score|fixture|match result)\b/i;
const GAMBLING =
  /\b(?:sportsbook|sports betting|betting|bet|odds|parlay|wager|casino|poker|roulette|blackjack|gambling)\b/i;
const GAMBLING_INSTRUCTIONS =
  /\b(?:picks?|tips?|strategy|system|best bet|sure bet|lock|parlay|odds|how (?:should|do) i bet|what should i bet)\b/i;
const COMPANY_ANALYSIS =
  /\b(?:public|listed|stock|shares?|company|operator|earnings|revenue|profit|margin|valuation|regulation|regulatory|balance sheet|financial performance|investment risk)\b/i;
const MISCONDUCT =
  /\b(?:insider trad(?:e|ing)|pump(?: and dump)?|dump scheme|spoof(?:ing)?|launder(?:ing)?|evade controls?|bypass controls?|fraud|deceptive promotion|market manipulation|wash trad(?:e|ing)|drainer|steal wallets?|nonpublic information)\b/i;
const CRYPTO =
  /\b(?:crypto|bitcoin|btc|ethereum|eth|token|memecoin|altcoin|stablecoin|blockchain|wallet|defi|nft)\b/i;
const CRYPTO_PROMOTION =
  /\b(?:100x|moon|guaranteed return|guaranteed profit|pump|shill|hype|best memecoin|which memecoin|token picks?|buy now|ape in|engineer hype|how (?:do|can) i buy|where (?:do|can) i buy|send (?:crypto|tokens?)|wallet instructions?)\b/i;
const CRYPTO_FINANCE_CONTEXT =
  /\b(?:market|regulation|regulatory|technology|business|company|stock|shares?|earnings|revenue|balance sheet|exposure|portfolio|risk|volatility|fund|etf|fundamental|accounting|custody|capital|liquidity|valuation)\b/i;
const FINANCE =
  /\b(?:p\/?e|price[- ]to[- ]earnings|ratio|public compan|equities|equity|stock|shares?|fund|etf|index|indices|fundamental|earnings|valuation|market|macroeconomic|economy|inflation|rates?|commodit|bank|financial|finance|invest|portfolio|dividend|bond|yield|price|trading|nasdaq|nyse|asx|s&p|dow|fed|gdp|recession|revenue|profit|balance sheet|cash flow|big\s*(?:4|four)|fortune\s*(?:100|500))\b/i;
const GENERAL_NEWS =
  /\b(?:celebrity|gossip|movie|music|entertainment|election|politics|politician|weather|recipe|travel)\b/i;
const PREDICTION_MARKET = /\bprediction markets?\b/i;

const scopeResponse =
  "StockSage focuses on financial markets and public-company research. Try asking about a company, fund, market, economic trend, or finance concept.";
const gamblingResponse =
  "I can’t help with betting picks, odds, or gambling strategies. I can analyze a listed operator’s financial performance, regulation, or investment risks.";
const misconductResponse =
  "I can’t help facilitate financial misconduct or bypass controls. I can discuss market rules, compliance risks, or legitimate investing practices.";
const cryptoPromotionResponse =
  "I can’t provide token hype, pump calls, or guaranteed-return picks. I can discuss crypto-related market exposure, regulation, or portfolio risk.";

export function evaluateDomainPolicy(
  message: string,
  entities: FinanceEntity[]
): DomainPolicyDecision {
  const text = message.trim();
  if (SELF_HARM.test(text)) {
    return {
      action: "respond",
      reasonCode: "explicit_self_harm",
      response:
        "I’m sorry you’re dealing with this. If you may act on thoughts of harming yourself, call local emergency services now. In Australia, Lifeline is available at 13 11 14; elsewhere, contact your local crisis line or emergency number.",
    };
  }
  if (SOCIAL.test(text) || FAREWELL.test(text)) {
    return { action: "allow", reasonCode: "social" };
  }
  if (MISCONDUCT.test(text)) {
    return {
      action: "respond",
      reasonCode: "prohibited_financial_misconduct",
      response: misconductResponse,
    };
  }
  if (CRYPTO.test(text) && CRYPTO_PROMOTION.test(text)) {
    return {
      action: "respond",
      reasonCode: "prohibited_crypto_promotion",
      response: cryptoPromotionResponse,
    };
  }
  if (GAMBLING.test(text)) {
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
  if (PREDICTION_MARKET.test(text) && !COMPANY_ANALYSIS.test(text)) {
    return {
      action: "clarify",
      reasonCode: "prohibited_gambling",
      response:
        "Are you asking about a listed prediction-market business, regulation, or financial risk? I can cover those topics, but not betting picks or strategies.",
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
      response: scopeResponse,
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
