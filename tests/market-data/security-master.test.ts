import "../no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";

import {
  createPolygonSecurityMasterAdapter,
  getCorporateActions,
  getCorporateActionsResult,
  getSecurityMasterSnapshot,
  normalizeCorporateActions,
  parseYahooCorporateActions,
  resolveSecurity,
  type CorporateAction,
} from "../../src/lib/market-data/security-master";
import { createProvenance } from "../../src/lib/market-data/provenance";

test("security master keeps issuer and instrument/proxy identities separate", async () => {
  const adapter = createPolygonSecurityMasterAdapter(
    async (url) => {
      assert.match(url, /reference\/tickers\/BHP/);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: {
            ticker: "BHP",
            name: "BHP Group Limited ADR",
            type: "ADRC",
            cik: "0000811809",
            primary_exchange: "XNYS",
            composite_figi: "BBG000...",
            active: true,
          },
        }),
      };
    },
    () => new Date("2026-08-09T00:00:00.000Z")
  );
  const security = await resolveSecurity(
    {
      ticker: "BHP",
      proxyFor: {
        kind: "adr",
        symbol: "BHP.AX",
        note: "US ADR for the Australian primary listing",
      },
    },
    { venue: "US", adapters: [adapter] }
  );
  assert.ok(security);
  assert.equal(security.issuer.cik, "0000811809");
  assert.equal(security.instrument.kind, "adr");
  assert.equal(security.instrument.currency, "USD");
  assert.equal(security.instrument.proxyFor?.symbol, "BHP.AX");
  assert.equal(security.provenance[0]?.proxyKind, "adr");
});

test("corporate actions from adapters are normalized, deduplicated and range-scoped", async () => {
  const now = new Date("2026-08-09T00:00:00.000Z");
  const provenance = createProvenance({
    provider: "fixture",
    fetchedAt: now,
  });
  const duplicate: CorporateAction = {
    id: "provider-id",
    ticker: "NVDA",
    kind: "split",
    exDate: "2024-06-10",
    ratio: 10,
    description: "10-for-1 split",
    provenance,
  };
  const actions = await getCorporateActions(
    "NVDA",
    { startSession: "2024-01-01", endSession: "2024-12-31" },
    {
      venue: "US",
      adapters: [
        {
          provider: "fixture",
          resolve: async () => null,
          corporateActions: async () => [
            duplicate,
            { ...duplicate, id: "another-provider-id" },
            {
              id: "",
              ticker: "NVDA",
              kind: "cash_dividend",
              exDate: "2024-06-11",
              amount: 0.01,
              currency: "USD",
              description: "cash dividend",
              provenance,
            },
          ],
        },
      ],
    }
  );
  assert.equal(actions.length, 2);
  assert.equal(actions[0]?.kind, "split");
  assert.match(actions[0]?.id ?? "", /^action:/);
  assert.deepEqual(normalizeCorporateActions(actions), actions);
});

test("corporate-action diagnostics expose partial provider verification", async () => {
  const provenance = createProvenance({
    provider: "fixture",
    fetchedAt: "2026-08-09T00:00:00.000Z",
  });
  const result = await getCorporateActionsResult(
    "NVDA",
    { startSession: "2024-01-01", endSession: "2024-12-31" },
    {
      venue: "US",
      adapters: [
        {
          provider: "fixture",
          resolve: async () => null,
          corporateActions: async () => [
            {
              id: "",
              ticker: "NVDA",
              kind: "split",
              exDate: "2024-06-10",
              ratio: 10,
              description: "10-for-1 split",
              provenance,
            },
          ],
        },
        {
          provider: "polygon",
          resolve: async () => null,
          corporateActions: async () => {
            throw new Error("fixture provider outage");
          },
        },
        {
          provider: "sec_edgar",
          resolve: async () => null,
        },
      ],
    }
  );
  assert.equal(result.status, "partial");
  assert.equal(result.actions.length, 1);
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.status),
    ["succeeded", "failed", "unsupported"]
  );
  assert.match(result.diagnostics[1]?.error ?? "", /fixture provider outage/);
});

test("security snapshots become partial when requested actions cannot be verified", async () => {
  const adapter = createPolygonSecurityMasterAdapter(async (url) => {
    if (url.includes("/v3/reference/tickers/NVDA")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: {
            ticker: "NVDA",
            name: "NVIDIA Corporation",
            type: "CS",
            cik: "0001045810",
            primary_exchange: "XNAS",
            active: true,
          },
        }),
      };
    }
    throw new Error("corporate-action endpoint unavailable");
  });
  const snapshot = await getSecurityMasterSnapshot(
    "NVDA",
    { startSession: "2024-01-01", endSession: "2024-12-31" },
    { venue: "US", adapters: [adapter] }
  );
  assert.equal(snapshot.status, "partial");
  assert.equal(snapshot.security?.instrument.symbol, "NVDA");
  assert.deepEqual(snapshot.corporateActions, []);
  assert.equal(snapshot.corporateActionRetrieval?.status, "unavailable");
  assert.deepEqual(
    snapshot.corporateActionRetrieval?.diagnostics.map(
      (diagnostic) => diagnostic.status
    ),
    ["failed"]
  );
  assert.match(
    snapshot.corporateActionRetrieval?.diagnostics[0]?.error ?? "",
    /corporate-action endpoint unavailable/
  );
});

test("Yahoo split and dividend events normalize without network access", () => {
  const provenance = createProvenance({
    provider: "yahoo",
    fetchedAt: "2026-08-09T00:00:00.000Z",
  });
  const actions = parseYahooCorporateActions(
    "CBA",
    {
      chart: {
        result: [
          {
            events: {
              dividends: {
                1: {
                  date: Date.parse("2025-02-19T00:00:00.000Z") / 1_000,
                  amount: 2.25,
                },
              },
              splits: {
                2: {
                  date: Date.parse("2025-03-01T00:00:00.000Z") / 1_000,
                  numerator: 1,
                  denominator: 10,
                },
              },
            },
          },
        ],
      },
    },
    provenance
  );
  assert.deepEqual(
    actions.map((action) => [action.kind, action.exDate]),
    [
      ["cash_dividend", "2025-02-19"],
      ["reverse_split", "2025-03-01"],
    ]
  );
  assert.equal(actions[1]?.ratio, 0.1);
});
