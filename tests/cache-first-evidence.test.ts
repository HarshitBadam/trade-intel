import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";

import {
  readCachedEvidence,
  resetEvidenceCacheMemory,
  writeCachedEvidence,
} from "../src/lib/stocksage/evidence/cache";
import { planEvidence } from "../src/lib/stocksage/evidence/planner";
import {
  executeEvidencePlan,
  type MarketIntelligenceSnapshot,
  type RetrievalProviders,
} from "../src/lib/stocksage/evidence/retrieve";
import { filterEvidenceWithDiagnostics } from "../src/lib/stocksage/evidence/filters";
import {
  onStockSageEvent,
  type StockSageEvent,
} from "../src/lib/stocksage/telemetry";
import type { EvidenceInput } from "../src/lib/stocksage/citations";
import type {
  ConversationState,
  EvidencePlan,
  FinanceEntity,
} from "../src/lib/stocksage/types";

const entities: FinanceEntity[] = [
  {
    id: "ticker:AAPL",
    name: "Apple",
    query: "Apple AAPL",
    ticker: "AAPL",
    market: "us",
  },
  {
    id: "ticker:MSFT",
    name: "Microsoft",
    query: "Microsoft MSFT",
    ticker: "MSFT",
    market: "us",
  },
];

function state(criteria: string[], selected = entities): ConversationState {
  return {
    version: 1,
    revision: 1,
    entities: selected,
    explicitEntitySet: selected.map((entity) => entity.id),
    criteria,
  };
}

function comparisonPlan(criteria = ["valuation", "risk"]): EvidencePlan {
  return planEvidence({
    route: "comparison",
    depth: "regular",
    message: `Compare Apple and Microsoft on ${criteria.join(" and ")}`,
    entities,
    state: state(criteria),
    asOf: "2026-08-05T00:00:00.000Z",
  });
}

function input(
  entity: FinanceEntity,
  criteria: string[],
  suffix = "snapshot"
): EvidenceInput {
  return {
    kind: "astra",
    title: `${entity.name} valuation growth and risk update`,
    outlet: "Reuters",
    publishedAt: "2026-08-04T00:00:00.000Z",
    url: `https://reuters.com/${entity.ticker?.toLowerCase()}-${suffix}`,
    excerpt: `${entity.name} valuation price-to-earnings multiple, revenue growth, earnings and risk volatility were updated.`,
    entityIds: [entity.id],
    criteria,
    queryId: "astra-comparison",
  };
}

function snapshot(
  entity: FinanceEntity,
  criteria: string[],
  revision: string,
  stateValue: MarketIntelligenceSnapshot["state"] = "fresh"
): MarketIntelligenceSnapshot {
  return {
    entityId: entity.id,
    ticker: entity.ticker!,
    revision,
    state: stateValue,
    inputs: criteria.length > 0 ? [input(entity, criteria, revision)] : [],
  };
}

function baseProviders(overrides: Partial<RetrievalProviders> = {}): RetrievalProviders {
  return {
    quotes: async () => [],
    astra: async () => [],
    tavily: async () => [],
    ...overrides,
  };
}

test("deep planner expands bounded risk, earnings, and outlook coverage", () => {
  const omitted = planEvidence({
    route: "comparison",
    message: "Compare Apple and Microsoft on valuation and risk",
    entities,
    state: state(["valuation", "risk"]),
    asOf: "2026-08-05T00:00:00.000Z",
  });
  const regular = comparisonPlan();
  const deep = planEvidence({
    route: "comparison",
    depth: "deep",
    message: "Compare Apple and Microsoft on valuation and risk",
    entities,
    state: state(["valuation", "risk"]),
    asOf: "2026-08-05T00:00:00.000Z",
  });
  assert.equal(omitted.depth, "regular");
  assert.deepEqual(regular.queries, omitted.queries);
  assert.equal(deep.depth, "deep");
  assert.deepEqual(deep.criteria, [
    "valuation",
    "risk",
    "earnings",
    "outlook",
  ]);
  const deepWeb = deep.queries.filter((query) => query.provider === "tavily");
  assert.equal(deepWeb.length, 4);
  assert.ok(deepWeb.some((query) => query.criteria.includes("risk")));
  assert.ok(deepWeb.some((query) => query.criteria.includes("earnings")));
  assert.ok(deepWeb.some((query) => query.criteria.includes("outlook")));
});

test("complete cache and MI coverage suppresses Tavily and fundamentals", async () => {
  const calls = { tavily: 0, fundamentals: 0 };
  let telemetry: StockSageEvent | undefined;
  const off = onStockSageEvent((event) => {
    if (event.event === "evidence_yield") telemetry = event;
  });
  try {
    const context = await executeEvidencePlan({
      plan: comparisonPlan(),
      entities,
      providers: baseProviders({
        marketIntelligence: async () =>
          entities.map((entity) =>
            snapshot(entity, ["valuation", "risk"], `fp-${entity.ticker}`)
          ),
        cacheRead: async () => [
          {
            ...input(entities[0], ["valuation", "risk"], "cache"),
            kind: "tavily",
          },
        ],
        fundamentals: async () => {
          calls.fundamentals += 1;
          return [];
        },
        tavily: async () => {
          calls.tavily += 1;
          return [];
        },
      }),
    });
    assert.deepEqual(calls, { tavily: 0, fundamentals: 0 });
    assert.equal(context.coverage["ticker:AAPL"], "covered");
    assert.equal(context.coverage["ticker:MSFT"], "covered");
    assert.deepEqual(telemetry?.coverageGaps, {
      "ticker:AAPL": [],
      "ticker:MSFT": [],
    });
    assert.equal(telemetry?.suppressedProviders?.tavily, 2);
    assert.deepEqual(telemetry?.cacheRevisions, {
      "ticker:AAPL": "fp-AAPL",
      "ticker:MSFT": "fp-MSFT",
    });
    assert.ok((telemetry?.yields?.sources ?? 0) > 0);
  } finally {
    off();
  }
});

test("partial multi-entity coverage fetches only uncovered cells", async () => {
  const fundamentalCalls: string[][] = [];
  const webQueries: EvidencePlan["queries"] = [];
  const context = await executeEvidencePlan({
    plan: comparisonPlan(),
    entities,
    providers: baseProviders({
      marketIntelligence: async () => [
        snapshot(entities[0], ["valuation"], "fp-aapl"),
        snapshot(entities[1], [], "fp-msft"),
      ],
      fundamentals: async (tickers) => {
        fundamentalCalls.push(tickers);
        return [
          {
            ticker: "AAPL",
            asOf: "2026-08-05",
            peTtm: null,
            revenueGrowthTtmYoy: null,
            beta: 1.1,
            earnings: null,
          },
          {
            ticker: "MSFT",
            asOf: "2026-08-05",
            peTtm: 32,
            revenueGrowthTtmYoy: null,
            beta: null,
            earnings: null,
          },
        ];
      },
      tavily: async (query) => {
        webQueries.push(query);
        return [
          {
            ...input(entities[1], ["risk"], "web-risk"),
            kind: "tavily",
            queryId: query.id,
          },
        ];
      },
    }),
  });
  assert.deepEqual(fundamentalCalls, [["AAPL", "MSFT"]]);
  assert.equal(webQueries.length, 1);
  assert.deepEqual(webQueries[0].entityIds, ["ticker:MSFT"]);
  assert.deepEqual(webQueries[0].criteria, ["risk"]);
  assert.equal(context.coverage["ticker:AAPL"], "covered");
  assert.equal(context.coverage["ticker:MSFT"], "covered");
});

test("content fingerprint rotation cannot read an old v2 cache entry", async () => {
  resetEvidenceCacheMemory();
  const one = entities.slice(0, 1);
  const plan = planEvidence({
    route: "current_finance",
    message: "Latest Apple earnings",
    entities: one,
    state: state(["earnings"], one),
    asOf: "2026-08-05T00:00:00.000Z",
  });
  const source = {
    id: "S1",
    ...input(one[0], ["earnings"], "cached"),
    entityIds: [one[0].id],
    criteria: ["earnings"],
    retrievedAt: "2026-08-05T00:00:00.000Z",
  };
  await writeCachedEvidence(plan, [source], {
    "ticker:AAPL": "content-fingerprint-one",
  });
  assert.equal(
    (
      await readCachedEvidence(plan, one, {
        "ticker:AAPL": "content-fingerprint-one",
      })
    ).length,
    1
  );
  assert.equal(
    (
      await readCachedEvidence(plan, one, {
        "ticker:AAPL": "content-fingerprint-two",
      })
    ).length,
    0
  );
});

test("stale refresh is deduped, bounded, and enqueue failure is harmless", async () => {
  const calls: string[] = [];
  const startedAt = Date.now();
  const context = await executeEvidencePlan({
    plan: comparisonPlan(),
    entities,
    ceilingMs: 150,
    providers: baseProviders({
      marketIntelligence: async () => [
        snapshot(entities[0], ["valuation", "risk"], "fp-a", "stale"),
        snapshot(entities[0], ["valuation", "risk"], "fp-a", "missing"),
        snapshot(entities[1], ["valuation", "risk"], "fp-m", "fresh"),
      ],
      refreshTicker: async (ticker) => {
        calls.push(ticker);
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error("queue unavailable");
      },
    }),
  });
  assert.deepEqual(calls, ["AAPL"]);
  assert.ok(Date.now() - startedAt < 150);
  assert.equal(context.coverage["ticker:AAPL"], "covered");
});

test("stalled refresh publication cannot exceed the retrieval ceiling", async () => {
  let refreshStarted = 0;
  let telemetry: StockSageEvent | undefined;
  const off = onStockSageEvent((event) => {
    if (event.event === "evidence_yield") telemetry = event;
  });
  const startedAt = Date.now();
  try {
    const context = await executeEvidencePlan({
      plan: comparisonPlan(),
      entities,
      ceilingMs: 40,
      providers: baseProviders({
        marketIntelligence: async () => [
          snapshot(entities[0], ["valuation", "risk"], "fp-a", "stale"),
          snapshot(entities[1], ["valuation", "risk"], "fp-m", "fresh"),
        ],
        refreshTicker: async () => {
          refreshStarted += 1;
          return new Promise(() => {});
        },
      }),
    });
    const elapsed = Date.now() - startedAt;
    assert.equal(refreshStarted, 1);
    assert.ok(elapsed < 150, `stalled refresh returned after ${elapsed}ms`);
    assert.equal(context.coverage["ticker:AAPL"], "covered");
    assert.equal(telemetry?.refreshDisposition?.timeout, 1);
  } finally {
    off();
  }
});

test("private and web-only stale entities never enqueue refreshes", async () => {
  const privateEntity: FinanceEntity = {
    id: "name:spacex",
    name: "SpaceX",
    query: "SpaceX",
    ticker: "SPACEX",
    market: "web",
    private: true,
  };
  const plan = planEvidence({
    route: "current_finance",
    message: "Latest SpaceX update",
    entities: [privateEntity],
    state: state(["current developments"], [privateEntity]),
    asOf: "2026-08-05T00:00:00.000Z",
  });
  let refreshes = 0;
  await executeEvidencePlan({
    plan,
    entities: [privateEntity],
    providers: baseProviders({
      marketIntelligence: async () => [
        snapshot(privateEntity, [], "missing-private", "missing"),
      ],
      refreshTicker: async () => {
        refreshes += 1;
        return { joined: false, publish: "accepted" };
      },
    }),
  });
  assert.equal(refreshes, 0);
});

test("ASX/US quote identity and retrieval deadline remain intact", async () => {
  const mixed: FinanceEntity[] = [
    entities[0],
    {
      id: "ticker:CBA.AX",
      name: "Commonwealth Bank",
      query: "Commonwealth Bank CBA ASX",
      ticker: "CBA.AX",
      market: "au",
    },
  ];
  const plan = planEvidence({
    route: "comparison",
    message: "Compare Apple and Commonwealth Bank on performance and risk",
    entities: mixed,
    state: state(["performance", "risk"], mixed),
    asOf: "2026-08-05T00:00:00.000Z",
  });
  const startedAt = Date.now();
  const context = await executeEvidencePlan({
    plan,
    entities: mixed,
    ceilingMs: 40,
    providers: baseProviders({
      quotes: async () => [
        {
          ticker: "AAPL",
          instrumentSymbol: "AAPL",
          venue: "US",
          currency: "USD",
          price: 200,
          asOf: "2026-08-05",
          dayPct: 1,
          fewDaysPct: null,
          weekPct: null,
          monthPct: null,
          yearPct: null,
        },
      ],
      marketProxy: async () => [
        {
          ticker: "CBA.AX",
          instrumentSymbol: "CBA.AX",
          venue: "ASX",
          currency: "AUD",
          price: 150,
          asOf: "2026-08-05",
          dayPct: 0.5,
          fewDaysPct: null,
          weekPct: null,
          monthPct: null,
          yearPct: null,
          proxySymbol: "CMWAY",
          proxyKind: "adr",
          sourceNote: "ADR fallback",
        },
      ],
      marketIntelligence: async () =>
        mixed.map((entity) => snapshot(entity, [], `fp-${entity.ticker}`)),
      tavily: async () => new Promise<EvidenceInput[]>(() => {}),
    }),
  });
  assert.ok(Date.now() - startedAt < 150);
  assert.equal(context.quotes.find((quote) => quote.ticker === "AAPL")?.venue, "US");
  assert.equal(
    context.quotes.find((quote) => quote.ticker === "CBA.AX")?.venue,
    "ASX"
  );
  assert.equal(context.bundle?.proxyIdentity["CBA.AX"]?.kind, "adr");
});

function manyEntities(count: number): FinanceEntity[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `ticker:TK${index}`,
    name: `Alpha${index}`,
    query: `Alpha${index} TK${index}`,
    ticker: `TK${index}`,
    market: "us" as const,
  }));
}

function directPlan(
  selected: FinanceEntity[],
  criteria = ["valuation", "risk"],
  freshnessDays = 14
): EvidencePlan {
  const entityIds = selected.map((entity) => entity.id);
  const tickers = selected.map((entity) => entity.ticker!);
  return {
    version: 1,
    depth: "regular",
    route: "comparison",
    asOf: "2026-08-05T00:00:00.000Z",
    requiredEntityIds: entityIds,
    criteria,
    explicitCriteria: criteria,
    queries: [
      {
        id: "astra-direct",
        provider: "astra",
        query: "direct market intelligence",
        entityIds,
        tickers,
        criteria,
        freshnessDays,
        topic: "news",
        limit: Math.max(4, selected.length),
      },
      {
        id: "tavily-direct",
        provider: "tavily",
        query: "direct web evidence",
        entityIds,
        tickers,
        criteria,
        freshnessDays,
        topic: "news",
        limit: Math.max(4, selected.length),
      },
    ],
  };
}

test(">4 entity accepted MI coverage suppresses Tavily before display capping", async () => {
  const selected = manyEntities(6);
  const plan = directPlan(selected);
  let tavilyCalls = 0;
  const context = await executeEvidencePlan({
    plan,
    entities: selected,
    providers: baseProviders({
      marketIntelligence: async (_query, [entity]) => [
        snapshot(entity, ["valuation", "risk"], `fp-${entity.ticker}`),
      ],
      tavily: async () => {
        tavilyCalls += 1;
        return [];
      },
    }),
  });
  assert.equal(tavilyCalls, 0);
  assert.equal(context.sources.length, 4);
  assert.ok(
    selected.every((entity) => context.coverage[entity.id] === "covered")
  );
});

test("a completed MI snapshot survives another entity timing out", async () => {
  const selected = manyEntities(2);
  const plan = directPlan(selected);
  const context = await executeEvidencePlan({
    plan,
    entities: selected,
    ceilingMs: 40,
    providers: baseProviders({
      marketIntelligence: async (_query, [entity]) =>
        entity.id === selected[0].id
          ? [snapshot(entity, ["valuation", "risk"], "fp-fast")]
          : new Promise<MarketIntelligenceSnapshot[]>(() => {}),
    }),
  });
  assert.ok(
    context.sources.some((source) =>
      source.entityIds.includes(selected[0].id)
    )
  );
  assert.equal(context.coverage[selected[0].id], "covered");
  assert.equal(context.coverage[selected[1].id], "missing");
});

test("hard-expired and degraded MI both request bounded refresh", async () => {
  const selected = manyEntities(2);
  const refreshed: string[] = [];
  await executeEvidencePlan({
    plan: directPlan(selected),
    entities: selected,
    providers: baseProviders({
      marketIntelligence: async (_query, [entity]) => [
        snapshot(
          entity,
          ["valuation", "risk"],
          `fp-${entity.ticker}`,
          entity.id === selected[0].id ? "hard_expired" : "degraded"
        ),
      ],
      refreshTicker: async (ticker) => {
        refreshed.push(ticker);
        return { joined: false, publish: "accepted" };
      },
    }),
  });
  assert.deepEqual(refreshed.sort(), selected.map((entity) => entity.ticker!).sort());
});

test("cache rehydration intersects actual criteria instead of widening valuation to risk", async () => {
  resetEvidenceCacheMemory();
  const selected = entities.slice(0, 1);
  const plan = directPlan(selected);
  await writeCachedEvidence(plan, [
    {
      id: "S1",
      ...input(selected[0], ["valuation"], "valuation-only"),
      entityIds: [selected[0].id],
      criteria: ["valuation"],
      queryId: "astra-direct",
      retrievedAt: "2026-08-05T00:00:00.000Z",
    },
  ]);
  const cached = await readCachedEvidence(plan, selected);
  assert.equal(cached.length, 1);
  assert.deepEqual(cached[0].criteria, ["valuation"]);
  const filtered = filterEvidenceWithDiagnostics({
    inputs: cached,
    plan,
    entities: selected,
  });
  assert.deepEqual(filtered.acceptedSources[0]?.criteria, ["valuation"]);
});

test("cache rehydration uses the matching provider query freshness", async () => {
  resetEvidenceCacheMemory();
  const selected = entities.slice(0, 1);
  const base = directPlan(selected, ["risk"], 60);
  const plan: EvidencePlan = {
    ...base,
    queries: [
      base.queries[0],
      { ...base.queries[1], freshnessDays: 7 },
    ],
  };
  await writeCachedEvidence(plan, [
    {
      id: "S1",
      ...input(selected[0], ["risk"], "old-risk"),
      kind: "tavily",
      publishedAt: "2026-07-15T00:00:00.000Z",
      entityIds: [selected[0].id],
      criteria: ["risk"],
      queryId: "retired-tavily-query",
      retrievedAt: "2026-08-05T00:00:00.000Z",
    },
  ]);
  const cached = await readCachedEvidence(plan, selected);
  assert.equal(cached[0]?.queryId, "tavily-direct");
  const filtered = filterEvidenceWithDiagnostics({
    inputs: cached,
    plan,
    entities: selected,
  });
  assert.equal(filtered.sources.length, 0);
  assert.equal(filtered.diagnostics.rejected.stale, 1);
});

test("in-memory evidence cache evicts old keys beyond its bound", async () => {
  resetEvidenceCacheMemory();
  const selected = manyEntities(257);
  for (const entity of selected) {
    const plan = directPlan([entity], ["risk"]);
    await writeCachedEvidence(plan, [
      {
        id: "S1",
        ...input(entity, ["risk"], "bounded"),
        entityIds: [entity.id],
        criteria: ["risk"],
        queryId: "astra-direct",
        retrievedAt: "2026-08-05T00:00:00.000Z",
      },
    ]);
  }
  assert.equal(
    (await readCachedEvidence(directPlan([selected[0]], ["risk"]), [selected[0]]))
      .length,
    0
  );
  assert.equal(
    (
      await readCachedEvidence(
        directPlan([selected.at(-1)!], ["risk"]),
        [selected.at(-1)!]
      )
    ).length,
    1
  );
});

test("custom Astra fallback is split per entity and revision", async () => {
  const selected = manyEntities(2);
  const calls: { entityIds: string[]; tickers: string[] }[] = [];
  let writtenRevisions: Record<string, string> | undefined;
  const context = await executeEvidencePlan({
    plan: directPlan(selected),
    entities: selected,
    providers: baseProviders({
      astra: async (query, narrowedEntities) => {
        calls.push({
          entityIds: [...query.entityIds],
          tickers: [...query.tickers],
        });
        return [
          {
            ...input(
              narrowedEntities[0],
              ["valuation", "risk"],
              `custom-${narrowedEntities[0].ticker}`
            ),
            queryId: query.id,
          },
        ];
      },
      cacheWrite: async (_plan, _sources, revisions) => {
        writtenRevisions = revisions;
      },
    }),
  });
  assert.deepEqual(
    calls.map((call) => call.entityIds),
    selected.map((entity) => [entity.id])
  );
  assert.deepEqual(
    calls.map((call) => call.tickers),
    selected.map((entity) => [entity.ticker])
  );
  assert.deepEqual(writtenRevisions, {
    [selected[0].id]: "generation-0",
    [selected[1].id]: "generation-0",
  });
  assert.ok(
    selected.every((entity) =>
      context.sources.some((source) => source.entityIds.includes(entity.id))
    )
  );
});
