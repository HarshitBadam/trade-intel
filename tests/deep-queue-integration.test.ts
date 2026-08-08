import "./no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";

test("Deep Research crosses enqueue, worker claim/finalize, and poll boundaries", async () => {
  process.env.GROQ_API_KEY = "test-groq-key";
  process.env.TAVILY_API_KEY = "test-tavily-key";
  process.env.STOCKSAGE_DEEP_SNAPSHOT_SECRET =
    "test-only-snapshot-secret-with-sufficient-length";

  const snapshotModule = await import(
    "../src/lib/stocksage/deep/snapshot"
  );
  const queueModule = await import("../src/lib/stocksage/deep/queue");
  const storeModule = await import("../src/lib/stocksage/deep/store");
  storeModule.resetDeepWorkMemory();
  queueModule.setDeepResearchPublisherForTests(async () => true);

  try {
    const entity = {
      id: "ticker:AAPL",
      name: "Apple",
      query: "Apple AAPL stock financial news",
      ticker: "AAPL",
      market: "us" as const,
    };
    const created = snapshotModule.createDeepResearchOffer({
      question: "Research Apple's current catalysts and risks.",
      reply: { text: "Regular Apple answer.", live: true },
      entities: [entity],
      state: {
        version: 1,
        revision: 1,
        entities: [entity],
        explicitEntitySet: [entity.id],
        criteria: ["risk", "outlook"],
      },
      sources: [],
      asOf: new Date().toISOString(),
      queueReady: true,
      eligible: true,
    });
    assert.ok(created.offer);

    const enqueued = await queueModule.enqueueDeepResearch(
      created.offer?.token
    );
    assert.deepEqual(enqueued, {
      status: "pending",
      workId: created.offer?.workId,
    });

    const snapshot = snapshotModule.parseDeepResearchSnapshot(
      created.offer?.token
    );
    assert.ok(snapshot);
    const identity = snapshotModule.deepResearchAttemptIdentity(snapshot!);
    const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    assert.ok(
      await storeModule.claimDeepWork({
        identity,
        owner,
        leaseMs: 30_000,
      })
    );
    assert.equal(
      await storeModule.finalizeDeepWork({
        identity,
        owner,
        reply: {
          workId: identity.workId,
          status: "success",
          text: "Completed deep report.",
          citationUrls: ["https://example.com/apple-report"],
        },
      }),
      true
    );

    const polled = await queueModule.getDeepResearchStatus(identity.workId);
    if (polled.status === "pending") assert.fail("worker result stayed pending");
    assert.equal(polled.status, "success");
    assert.equal(polled.reply.text, "Completed deep report.");
  } finally {
    queueModule.setDeepResearchPublisherForTests(undefined);
    storeModule.resetDeepWorkMemory();
  }
});
