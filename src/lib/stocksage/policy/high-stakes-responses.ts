export type HighStakesKind =
  | "guarantee_positive"
  | "guarantee_negative"
  | "life_event_past"
  | "life_event_forward"
  | "position_directive";

export const HIGH_STAKES_VARIANTS: Record<HighStakesKind, string[]> = {
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
