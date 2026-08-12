import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";

import {
  getSecCompanyFacts,
  listSecFilings,
  normalizeSecCompanyFacts,
  resolveCik,
  type SecFetch,
} from "../src/lib/market-data/sec-edgar";

const TICKER_FIXTURE = {
  0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
  1: { cik_str: 789019, ticker: "MSFT", title: "Microsoft Corp." },
};

const SUBMISSION_FIXTURE = {
  cik: "0000320193",
  entityType: "operating",
  sic: "3571",
  sicDescription: "Electronic Computers",
  name: "Apple Inc.",
  tickers: ["AAPL"],
  exchanges: ["Nasdaq"],
  stateOfIncorporation: "CA",
  fiscalYearEnd: "0928",
  filings: {
    recent: {
      accessionNumber: ["0000320193-26-000001", "0000320193-25-000002"],
      filingDate: ["2026-02-01", "2025-11-01"],
      reportDate: ["2025-12-31", "2025-09-27"],
      acceptanceDateTime: ["20260201120000", "20251101120000"],
      form: ["10-Q", "10-K"],
      fileNumber: ["001-36743", "001-36743"],
      filmNumber: ["", ""],
      items: ["", ""],
      size: [100, 200],
      isXBRL: [1, 1],
      isInlineXBRL: [1, 1],
      primaryDocument: ["aapl-20251231.htm", "aapl-20250927.htm"],
      primaryDocDescription: ["10-Q", "10-K"],
    },
    files: [{ name: "CIK0000320193-submissions-001.json" }],
  },
};

const HISTORICAL_FIXTURE = {
  accessionNumber: ["0000320193-20-000003"],
  filingDate: ["2020-10-30"],
  reportDate: ["2020-09-26"],
  acceptanceDateTime: ["20201030120000"],
  form: ["10-K"],
  fileNumber: ["001-36743"],
  filmNumber: [""],
  items: [""],
  size: [300],
  isXBRL: [1],
  isInlineXBRL: [1],
  primaryDocument: ["aapl-20200926.htm"],
  primaryDocDescription: ["10-K"],
};

const FACTS_FIXTURE = {
  cik: 320193,
  entityName: "Apple Inc.",
  facts: {
    "us-gaap": {
      Revenues: {
        label: "Revenue",
        description: "Revenue recognized.",
        units: {
          USD: [
            {
              start: "2024-09-29",
              end: "2025-09-27",
              val: 400_000_000_000,
              accn: "0000320193-25-000002",
              fy: 2025,
              fp: "FY",
              form: "10-K",
              filed: "2025-11-01",
              frame: "CY2025",
            },
            {
              start: "2025-09-28",
              end: "2025-12-31",
              val: 120_000_000_000,
              accn: "0000320193-26-000001",
              fy: 2026,
              fp: "Q1",
              form: "10-Q",
              filed: "2026-02-01",
              frame: "CY2025Q4",
            },
          ],
        },
      },
      Assets: {
        label: "Assets",
        units: {
          USD: [
            {
              end: "2025-09-27",
              val: 360_000_000_000,
              accn: "0000320193-25-000002",
              fy: 2025,
              fp: "FY",
              form: "10-K",
              filed: "2025-11-01",
            },
          ],
        },
      },
    },
    dei: {
      EntityPublicFloat: {
        label: "Public Float",
        units: {
          USD: [
            {
              end: "2025-06-30",
              val: 3_000_000_000_000,
              accn: "0000320193-25-000002",
              form: "10-K",
              filed: "2025-11-01",
            },
          ],
        },
      },
    },
  },
};

function secFixtureFetch(calls: Array<{ url: string; userAgent: string }>): SecFetch {
  return async (url, init) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ url, userAgent: headers["User-Agent"] });
    const payload = url.endsWith("/files/company_tickers.json")
      ? TICKER_FIXTURE
      : url.endsWith("/submissions/CIK0000320193.json")
        ? SUBMISSION_FIXTURE
        : url.endsWith("CIK0000320193-submissions-001.json")
          ? HISTORICAL_FIXTURE
          : url.endsWith("/api/xbrl/companyfacts/CIK0000320193.json")
            ? FACTS_FIXTURE
            : undefined;
    return {
      ok: payload !== undefined,
      status: payload === undefined ? 404 : 200,
      json: async () => payload,
    };
  };
}

test("SEC ticker resolution, submissions and metadata filters are deterministic", async () => {
  const calls: Array<{ url: string; userAgent: string }> = [];
  const dependencies = {
    fetch: secFixtureFetch(calls),
    acquire: async () => {},
    userAgent: "TradeIntel tests test@example.com",
    now: () => new Date("2026-08-09T00:00:00.000Z"),
  };
  assert.equal(await resolveCik(" aapl ", dependencies), "0000320193");
  const filings = await listSecFilings(
    {
      ticker: "AAPL",
      forms: ["10-K"],
      filedFrom: "2019-01-01",
      filedTo: "2025-12-31",
      limit: 10,
    },
    dependencies
  );
  assert.deepEqual(
    filings.map((item) => [item.form, item.filedAt, item.accessionNumber]),
    [
      ["10-K", "2025-11-01", "0000320193-25-000002"],
      ["10-K", "2020-10-30", "0000320193-20-000003"],
    ]
  );
  assert.match(filings[0]?.url ?? "", /Archives\/edgar\/data\/320193\//);
  assert.match(filings[0]?.documentUrl ?? "", /aapl-20250927\.htm$/);
  assert.ok(calls.every((call) => call.userAgent.includes("test@example.com")));
  assert.ok(
    calls.some((call) =>
      call.url.endsWith("CIK0000320193-submissions-001.json")
    ),
    "historical submission files are included rather than imposing a recent window"
  );
});

test("XBRL company facts support concept/form/date filters and stable normalization", async () => {
  const first = normalizeSecCompanyFacts(
    FACTS_FIXTURE,
    {
      concepts: ["Revenues"],
      forms: ["10-K"],
      filedFrom: "2025-01-01",
      filedTo: "2025-12-31",
    },
    new Date("2026-08-09T00:00:00.000Z")
  );
  const second = normalizeSecCompanyFacts(
    FACTS_FIXTURE,
    {
      concepts: ["Revenues"],
      forms: ["10-K"],
      filedFrom: "2025-01-01",
      filedTo: "2025-12-31",
    },
    new Date("2026-08-09T00:00:00.000Z")
  );
  assert.deepEqual(second, first);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.value, 400_000_000_000);
  assert.equal(first[0]?.instant, false);
  assert.match(first[0]?.id ?? "", /us-gaap:Revenues:USD/);

  const calls: Array<{ url: string; userAgent: string }> = [];
  const latest = await getSecCompanyFacts(
    {
      ticker: "AAPL",
      concepts: ["Revenues"],
      forms: ["10-Q", "10-K"],
      latestOnly: true,
    },
    {
      fetch: secFixtureFetch(calls),
      acquire: async () => {},
      now: () => new Date("2026-08-09T00:00:00.000Z"),
    }
  );
  assert.equal(latest.length, 1);
  assert.equal(latest[0]?.form, "10-Q");
  assert.equal(latest[0]?.periodEnd, "2025-12-31");
});
