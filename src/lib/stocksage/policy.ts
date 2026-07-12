import type {
  DomainPolicyDecision,
  FinanceEntity,
} from "./types";

const SOCIAL =
  /^(?:(?:hey|hi|hello|hiya|howdy|sup|g'?day|good\s+(?:morning|afternoon|evening))(?:\s+again)?(?:,\s*i'?m back)?(?:[,\s]+(?:boss|bro|mate|dude|there|sage|stocksage))?|i'?m back|how are you|how'?s it going(?:[,\s]+(?:boss|bro|mate|dude))?|what'?s up(?:[,\s]+(?:boss|bro|mate|dude))?|nice to meet you|aight(?:\s+gucci)?(?:\s+then)?|cool|sounds good|okay|ok|thx|thanks?(?:,\s*that helps|\s+(?:boss|bro|mate|dude))?|thank you(?:\s+(?:boss|bro|mate|dude))?|cheers(?:\s+(?:boss|bro|mate|dude))?|much appreciated|that helps|got it|gotcha|help|help me|what can you(?: actually)? (?:do|help me with)|how can you help)[\s,.!?…-]*$/i;
const FAREWELL =
  /^(?:bye|goodbye|see you)(?:[\s,]+(?:for now|later|soon|again|then|boss|bro|mate|dude|thanks|thank you))*[\s,.!?…-]*$/i;
const CASUAL_ACKNOWLEDGEMENT =
  /^(?:thx|thanks?|thank you|cheers)(?:\s+(?:boss|bro|mate|dude))?(?:,?\s+that helps)?[\s,.!?…-]*$/i;
const FRUSTRATION =
  /\b(?:fuck|shit|damn)\b.*\b(?:annoying|frustrating|useless|broken)\b/i;
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
  /\b(?:insider trad(?:e|ing)|pump(?: and dump)?|dump scheme|spoof(?:ing)?|launder(?:ing)?|evade controls?|bypass controls?|fraud|deceptive promotion|market manipulation|manipulat(?:e|ing)\s+the\s+market|wash trad(?:e|ing)|drainer|steal wallets?|nonpublic information)\b/i;
const FACILITATION =
  /\b(?:help me|show me|give me|how (?:do|can|should)|steps?|plan|coordinate|execute|use|exploit|evade|bypass|steal|launder|pump|spoof|manipulate)\b/i;
const LOCAL_SECRET_ACCESS =
  /\b(?:read|open|access|show|list|print|reveal|find)\b.{0,80}\b(?:\.env(?:\.local)?|local files?|api keys?|tokens?|secrets?|credentials?)\b/i;
const FINANCIAL_ACTION =
  /\b(?:place|execute|submit|make)\b.{0,60}\b(?:trade|order)\b|\b(?:transfer|send|move)\b.{0,60}\b(?:money|funds?|\$\s*\d)/i;
const CRYPTO =
  /\b(?:crypto|bitcoin|btc|ethereum|eth|token|memecoin|altcoin|stablecoin|blockchain|wallet|defi|nft)\b/i;
const CRYPTO_EXECUTION =
  /\b(?:execute|place|buy|sell|swap|transfer|send)\b.{0,50}\b(?:trade|order|crypto|bitcoin|token|wallet)|\b(?:wallet|transfer)\s+(?:steps?|instructions?)\b/i;
const CRYPTO_PROMOTION =
  /\b(?:100x|moon|guaranteed return|guaranteed profit|pump|shill|hype|best memecoin|which memecoin|token picks?|buy now|ape in|engineer hype|how (?:do|can) i buy|where (?:do|can) i buy|send (?:crypto|tokens?)|wallet instructions?)\b/i;
const CRYPTO_FINANCE_CONTEXT =
  /\b(?:market|regulation|regulatory|technology|business|company|stock|shares?|earnings|revenue|balance sheet|exposure|portfolio|risk|volatility|fund|etf|fundamental|accounting|custody|capital|liquidity|valuation)\b/i;
const FINANCE =
  /\b(?:p\/?e|price[- ]to[- ]earnings|ratio|compan(?:y|ies)|compare|ranking|equities|equity|stock|shares?|fund|etf|index|indices|fundamental|earnings|valuation|performance|momentum|outlook|risks?|market|macroeconomic|economy|inflation|rates?|commodit|bank|financial|finance|invest|portfolio|dividend|bond|yield|price|trading|nasdaq|nyse|asx|s&p|dow|fed|gdp|recession|revenue|profit|balance sheet|cash flow|big\s*(?:4|four)|fortune\s*(?:100|500))\b/i;
const GENERAL_NEWS =
  /\b(?:celebrity|gossip|movie|music|entertainment|election|politics|politician|weather|recipe|travel)\b/i;
const PREDICTION_MARKET = /\bprediction markets?\b/i;

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
  if (
    SOCIAL.test(text) ||
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
