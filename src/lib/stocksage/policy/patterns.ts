export const CODE =
  /\b(?:python|javascript|typescript|java|c\+\+|code|script|function|loop|syntax|compile|runtime|console\.log|print\s*\(|for\s+\w+\s+in\s+range)\b/i;
export const CREATIVE_ASK =
  /\b(?:write|writing|compose|pen|craft)\b[^.!?;\n]{0,40}\b(?:haikus?|poems?|poetry|songs?|raps?|stor(?:y|ies)|jokes?|limericks?|sonnets?|lyrics|ballads?|odes?|verses?)\b|\b(?:tell|give|make|do|sing)\s+(?:me\s+|us\s+)?(?:a|an|another|one more|some)\s+(?:\w+\s+){0,2}?(?:haiku|poem|song|rap|story|joke|limerick|sonnet|ballad|ode)\b|\b(?:a\s+)?(?:haiku|limerick|sonnet|ballad|ode)\s+about\b/i;
export const FINANCE_ASK =
  /\b(?:how(?:'?s| is| are| did| has| have)|what(?:'?s| is| are| about| happened| moved)|compare|vs\.?|versus|rank|wb|price[sd]?|trading|perform(?:s|ed|ing|ance)?|doing|moved?|outlook|earnings|risks?)\b/i;
export const SPORTS =
  /\b(?:sports?|football|soccer|cricket|rugby|basketball|baseball|tennis|afl|nfl|nba|score|fixture|match result)\b/i;
export const GAMBLING =
  /\b(?:sportsbook|sports betting|betting|bet|odds|parlay|wager|casino|poker|roulette|blackjack|gambling)\b/i;
export const GAMBLING_INSTRUCTIONS =
  /\b(?:picks?|tips?|strategy|system|best bet|sure bet|lock|parlay|odds|how (?:should|do) i bet|what should i bet)\b/i;
export const COMPANY_ANALYSIS =
  /\b(?:public|listed|stock|shares?|company|operator|earnings|revenue|profit|margin|valuation|regulation|regulatory|balance sheet|financial performance|investment risk)\b/i;
export const MISCONDUCT =
  /\b(?:insider trad(?:e|ing)|pump(?: and dump)?|dump scheme|spoof(?:ing)?|launder(?:ing)?|evade controls?|bypass controls?|fraud|deceptive promotion|market manipulation|manipulat(?:e|ing)\s+the\s+market|wash trad(?:e|ing)|drainer|steal wallets?|nonpublic information)\b/i;
export const FACILITATION =
  /\b(?:help me|show me|give me|how (?:do|can|should)|steps?|plan|coordinate|execute|use|exploit|evade|bypass|steal|launder|pump|spoof|manipulate)\b/i;
export const LOCAL_SECRET_ACCESS =
  /\b(?:read|open|access|show|list|print|reveal|find|cat|dump|paste|leak|expose|grab|fetch|extract|copy|run cat|echo)\b.{0,80}\b(?:\.env(?:\.local)?|env file|environment variables?|local files?|api keys?|tokens?|secrets?|credentials?|(?:tavily|groq|polygon|alpaca|finnhub|astra|upstash) key)\b/i;
export const FINANCIAL_ACTION =
  /\b(?:place|execute|submit|make)\b.{0,60}\b(?:buy|sell|trade|order)\b|\b(?:buy|sell)\b.{0,60}\b(?:shares?|stocks?)\b.{0,30}\b(?:for me|on my behalf)\b|\b(?:transfer|send|move)\b.{0,60}\b(?:money|funds?|\$\s*\d)/i;
export const CRYPTO =
  /\b(?:crypto|bitcoin|btc|ethereum|eth|token|memecoin|altcoin|stablecoin|blockchain|wallet|defi|nft)\b/i;
export const CRYPTO_EXECUTION =
  /\b(?:execute|place|buy|sell|swap|transfer|send)\b.{0,50}\b(?:trade|order|crypto|bitcoin|token|wallet)|\b(?:wallet|transfer)\s+(?:steps?|instructions?)\b/i;
export const CRYPTO_PROMOTION =
  /\b(?:\d{2,4}x|moon(?:shot)?|guaranteed return|guaranteed profit|pump|shill|hype|best memecoin|which (?:memecoin|altcoin)|token picks?|buy now|ape (?:in|into)|engineer hype|how (?:do|can) i buy|where (?:do|can) i buy|send (?:crypto|tokens?)|wallet instructions?)\b/i;
export const CRYPTO_FINANCE_CONTEXT =
  /\b(?:market|regulation|regulatory|technology|business|company|stock|shares?|earnings|revenue|balance sheet|exposure|portfolio|risk|volatility|fund|etf|fundamental|accounting|custody|capital|liquidity|valuation)\b/i;
export const FINANCE =
  /\b(?:p\/?e|price[- ]to[- ]earnings|ratio|compan(?:y|ies)|compare|ranking|equities|equity|stock|shares?|fund|etf|index|indices|fundamental|earnings|valuation|performance|momentum|outlook|risks?|returns?|market|macroeconomic|economy|inflation|rates?|commodit|bank|financial|finance|invest|portfolio|dividend|bond|yield|price|trading|nasdaq|nyse|asx|s&p|dow|fed|gdp|recession|revenue|profit|balance sheet|cash flow|big\s*(?:4|four)|fortune\s*(?:100|500))\b/i;
export const GENERAL_NEWS =
  /\b(?:celebrity|gossip|movie|music|entertainment|election|politics|politician|weather|recipe|travel)\b/i;
export const PREDICTION_MARKET = /\bprediction markets?\b/i;
export const GUARANTEE =
  /\b(?:guarantee(?:s|d|ing)?|promis(?:e|es|ed|ing)|assur(?:e|es|ed|ing)|are you (?:sure|positive|certain)|can you (?:guarantee|promise|assure))\b.{0,90}\b(?:returns?|profits?|double|triple|\d{1,4}x|gains?|go(?:es|ing)? (?:up|down)|positive|negative|perform(?:s|ance|ing)?(?:\s+poorly|\s+well)?|money|lose|loss|year end)\b|\b(?:guaranteed|risk[- ]free|sure[- ]thing)\s+(?:returns?|profits?|picks?|stocks?|winners?)\b|\bno risk\b|\b(?:no|zero)\s+chance\b.{0,80}\b(?:fall|drop|decline|crash|lose|rise|rally|gain|go (?:up|down)|perform (?:poorly|well))\b|\bso you(?:'re| are) saying\b.{0,80}\b(?:will|won't|cannot|can't)\b.{0,30}\b(?:fall|drop|decline|crash|lose|rise|rally|gain|perform (?:poorly|well))\b/i;
export const RETURN_SEEKING_PICK =
  /\b(?:which|what|pick|name|tell me|best|top|fastest|quickest|soonest)\b.{0,70}\b(?:stocks?|shares?|tickers?|investments?)\b.{0,80}\b(?:would|will|can|could|most likely to)?\b.{0,30}\b(?:double|triple|2x|3x|\d{2,4}x)\b.{0,40}\b(?:my\s+)?(?:money|returns?|profits?|gains?)\b|\b(?:double|triple|2x|3x|\d{2,4}x)\b.{0,35}\b(?:my\s+)?(?:money|returns?|profits?|gains?)\b.{0,70}\b(?:which|what|pick|stock|ticker|investment|soonest|fastest|quickest)\b/i;
export const LIFE_EVENT_STAKE =
  /\b(?:sell my house|sold my house|selling my house|house (?:proceeds|money|sale)|inheritance|life savings|retirement (?:savings|fund)|superannuation|my super\b|redundancy (?:pay(?:out)?)?|mortgage refinance|divorce settlement)\b/i;
export const ALL_IN =
  /\b(?:all[- ]in|everything (?:into|on|in)\b|(?:put|dump(?:ed)?|threw|poured|deposit(?:ed|ing)?|deposite(?:d|ing)?|invest(?:ed|ing)?) (?:it|them) all (?:into|on|in)\b|entire (?:savings|portfolio|position)|whole (?:savings|portfolio)|bet (?:everything|it all)|(?:one|a single) concentrated bet|remaining savings)\b/i;
export const PERSONAL_POSITION_DIRECTIVE =
  /\bshould i (?:sell|buy|hold|dump|exit|double down|go all[- ]in)\b|\b(?:sell|dump)\s+(?:all\s+)?my (?:entire\s+)?(?:position|shares?|holdings?|stock)\b/i;
export const CASINO_OR_SPORTSBOOK =
  /\b(?:sportsbook|casino|poker|roulette|blackjack|parlay|bookie|odds|lock)\b/i;
export const INVESTING_CONTEXT =
  /\b(?:stocks?|tickers?|shares?|etfs?|index|indices|portfolio|invest(?:ing|ment)?|equit(?:y|ies)|market|returns?|profits?|positions?|holdings?|perform(?:s|ing|ance)?)\b/i;
export const TICKER_MENTION =
  /(?:^|\s)\$?[A-Z]{2,5}(?:\.[A-Z]{1,3})?(?=[\s,.!?]|$)/;
export const NEGATIVE_DIRECTION =
  /\b(?:poorly|badly|underperform|go(?:es|ing)?\s+down|negative|lose|loss(?:es)?|tank|drop|fall|crash|decline)\b/i;
export const NO_CHANCE_DOWNSIDE =
  /\b(?:no|zero)\s+chance\b.{0,80}\b(?:fall|drop|decline|crash|lose|go down)\b/i;
export const NO_CHANCE_UPSIDE =
  /\b(?:no|zero)\s+chance\b.{0,80}\b(?:rise|rally|gain|go up|perform well)\b/i;
export const FORWARD_LOOKING =
  /\b(?:should|shall|can|could)\s+i\b|\bthinking (?:of|about)\b|\bplanning (?:to|on)\b|\bgoing to\b|\babout to\b|\bworth (?:putting|adding|buying)\b|\b(?:put|add|invest)\b.{0,40}\btoo\b/i;
