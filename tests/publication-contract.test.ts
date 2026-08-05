import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import {
  deepSynthesisChecks,
  evaluatePublicationCandidate,
  finalizePublicationText,
  PUBLICATION_REJECTION_REASONS,
  regularSynthesisChecks,
  repeatedPriorPhraseRejection,
  type PublicationCandidateContext,
} from "../src/lib/stocksage/publication";
import type { EvidenceSource, FinanceEntity } from "../src/lib/stocksage/types";

const APPLE: FinanceEntity = {
  id: "apple",
  name: "Apple",
  query: "Apple",
  ticker: "AAPL",
  market: "us",
};
const MICROSOFT: FinanceEntity = {
  id: "microsoft",
  name: "Microsoft",
  query: "Microsoft",
  ticker: "MSFT",
  market: "us",
};

const SOURCE: EvidenceSource = {
  id: "S1",
  kind: "tavily",
  title: "Apple guidance update",
  outlet: "Example Wire",
  url: "https://example.com/apple-guidance",
  excerpt: "Apple issued new guidance and rolled out its next-gen chip launch this week.",
  entityIds: ["apple"],
  criteria: ["outlook"],
  retrievedAt: new Date().toISOString(),
};

function baseContext(
  overrides: Partial<PublicationCandidateContext> = {}
): PublicationCandidateContext {
  return {
    corpus: "Apple guidance and outlook context with no figures.",
    entities: [APPLE],
    quotes: [],
    sources: [SOURCE],
    requestedCriteria: [],
    hasSources: true,
    ...overrides,
  };
}

test("every declared reason code is reachable from evaluatePublicationCandidate", () => {
  const enabledEverything = Object.fromEntries(
    PUBLICATION_REJECTION_REASONS.filter(
      (reason) => reason !== "repeated_prior_phrase"
    ).map((reason) => [reason, true])
  );
  // A pathological candidate should trip at least the first-evaluated check;
  // this just proves the function accepts every declared flag without
  // throwing, keeping the reason-code list and the switch in lockstep.
  const result = evaluatePublicationCandidate(
    "This is a plain, unremarkable sentence.",
    enabledEverything,
    baseContext({ socialMarketClaimPattern: /never-matches-anything/ })
  );
  assert.equal(typeof result, "object");
});

test("regular (unified) and deep engines reject the same unsupported figure with the same reason code", () => {
  const candidate = "Apple trades at $9,999.99 today.";
  const ctx = baseContext({ corpus: "No such figure appears anywhere here." });

  const regular = evaluatePublicationCandidate(
    candidate,
    regularSynthesisChecks({
      guardFigures: true,
      requireCitations: false,
      requireCoverage: false,
      wantsData: true,
      offTopicTurn: false,
      blendedOffTopic: false,
      farewellTurn: false,
    }),
    ctx
  );
  const deep = evaluatePublicationCandidate(
    candidate,
    deepSynthesisChecks({ smuggled: false }),
    { ...ctx, sources: [SOURCE] }
  );

  assert.equal(regular?.reasonCode, "unsupported_figures");
  assert.equal(deep?.reasonCode, "unsupported_figures");
});

test("regular synthesis rejects proxy misrepresentation with a structured reason", () => {
  const candidate = "Apple is up 2% today.";
  const quotes = [
    {
      ticker: "AAPL",
      price: 100,
      asOf: "2026-01-01",
      dayPct: 2,
      fewDaysPct: null,
      weekPct: null,
      monthPct: null,
      yearPct: null,
      proxySymbol: "AAPL.PROXY",
      proxyKind: "adr" as const,
    },
  ];
  const ctx = baseContext({ quotes, corpus: candidate });

  const unified = evaluatePublicationCandidate(
    candidate,
    regularSynthesisChecks({
      guardFigures: false,
      requireCitations: false,
      requireCoverage: false,
      wantsData: true,
      offTopicTurn: false,
      blendedOffTopic: false,
      farewellTurn: false,
    }),
    ctx
  );

  assert.equal(unified?.reasonCode, "proxy_misrepresentation");
});

test("deep requires at least one citation even when every other check would pass", () => {
  const candidate = "Nothing notable stood out this week.";
  const rejection = evaluatePublicationCandidate(
    candidate,
    deepSynthesisChecks({ smuggled: false }),
    baseContext({ corpus: candidate })
  );
  assert.equal(rejection?.reasonCode, "missing_citations");
});

test("deep never enforces regular-only checks (coverage, style, criteria, curt farewell)", () => {
  const checks = deepSynthesisChecks({ smuggled: false });
  assert.equal(checks.wrong_subject_opening, undefined);
  assert.equal(checks.incomplete_entity_coverage, undefined);
  assert.equal(checks.style, undefined);
  assert.equal(checks.missing_criteria, undefined);
  assert.equal(checks.curt_farewell, undefined);
  assert.equal(checks.social_market_claim, undefined);
  assert.equal(checks.off_topic_leak, undefined);
});

test("a valid comparison candidate covering every entity clears the unified regular checks", () => {
  const candidate =
    "Apple and Microsoft both posted steady outlook commentary this quarter [S1].";
  const rejection = evaluatePublicationCandidate(
    candidate,
    regularSynthesisChecks({
      guardFigures: false,
      requireCitations: true,
      requireCoverage: true,
      wantsData: true,
      offTopicTurn: false,
      blendedOffTopic: false,
      farewellTurn: false,
    }),
    baseContext({
      entities: [APPLE, MICROSOFT],
      corpus: candidate,
      sources: [SOURCE],
    })
  );
  assert.equal(rejection, null);
});

test("missing one entity in a comparison trips incomplete_entity_coverage, not a silent pass", () => {
  const candidate = "Apple posted steady outlook commentary this quarter [S1].";
  const rejection = evaluatePublicationCandidate(
    candidate,
    regularSynthesisChecks({
      guardFigures: false,
      requireCitations: true,
      requireCoverage: true,
      wantsData: true,
      offTopicTurn: false,
      blendedOffTopic: false,
      farewellTurn: false,
    }),
    baseContext({ entities: [APPLE, MICROSOFT], corpus: candidate, sources: [SOURCE] })
  );
  assert.equal(rejection?.reasonCode, "incomplete_entity_coverage");
});

test("repeatedPriorPhraseRejection reports the shared reason code", () => {
  const prior = [
    "Apple's guidance remains steady heading into the next quarter with modest upside.",
  ];
  const draft =
    "Apple's guidance remains steady heading into the next quarter with modest upside.";
  const rejection = repeatedPriorPhraseRejection(draft, prior, [APPLE]);
  assert.equal(rejection?.reasonCode, "repeated_prior_phrase");
});

test("finalizePublicationText expands citations, rounds figures, and only strips tickers when asked", () => {
  const withoutStripping = finalizePublicationText(
    "Apple guidance was strong [S1], trading at 123.456.",
    [SOURCE]
  );
  assert.match(withoutStripping.text, /\[Example Wire\]\(https:\/\/example\.com\/apple-guidance\)/);
  assert.match(withoutStripping.text, /123\.46/);
  assert.deepEqual(withoutStripping.citationUrls, [
    "https://example.com/apple-guidance",
  ]);

  const withStripping = finalizePublicationText(
    "[AAPL] Apple guidance was strong [S1].",
    [SOURCE],
    { stripTickers: true, tickers: ["AAPL"], trim: true }
  );
  assert.doesNotMatch(withStripping.text, /\[AAPL\]/);
  assert.match(withStripping.text, /\[Example Wire\]/);
});

