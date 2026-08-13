import "../no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLlmRequestBody,
  LlmJsonParseError,
  LlmRequestError,
} from "../../src/lib/llm";
import {
  executeSimpleLlmFallback,
  simpleLlmChatJSON,
  shouldFallbackSimpleLlm,
  type SimpleLlmTarget,
} from "../../src/lib/stocksage/simple/llm";

const CEREBRAS: SimpleLlmTarget = {
  vendor: "cerebras",
  model: "gpt-oss-120b",
};
const GROQ: SimpleLlmTarget = {
  vendor: "groq",
  model: "qwen/qwen3.6-27b",
};

test("switches only for failures another provider can reasonably recover", () => {
  const cases: Array<[unknown, boolean]> = [
    [new LlmJsonParseError(), true],
    [new LlmRequestError("network failure"), true],
    [new LlmRequestError("timeout", { status: 408 }), true],
    [new LlmRequestError("rate limited", { status: 429 }), true],
    [new LlmRequestError("server failure", { status: 500 }), true],
    [new LlmRequestError("unavailable", { status: 503 }), true],
    [new LlmRequestError("bad request", { status: 400 }), false],
    [new LlmRequestError("unauthorized", { status: 401 }), false],
    [new LlmRequestError("forbidden", { status: 403 }), false],
    [new LlmRequestError("too large", { status: 413 }), false],
    [new LlmRequestError("invalid request", { status: 422 }), false],
    [new TypeError("programming error"), false],
  ];
  for (const [error, expected] of cases) {
    assert.equal(shouldFallbackSimpleLlm(error), expected);
  }
});

test("returns a successful primary response without touching the fallback", async () => {
  const attempts: SimpleLlmTarget[] = [];
  const result = await executeSimpleLlmFallback(
    CEREBRAS,
    GROQ,
    async (target) => {
      attempts.push(target);
      return "primary response";
    },
    () => true
  );
  assert.equal(result, "primary response");
  assert.deepEqual(attempts, [CEREBRAS]);
});

test("uses only the fallback when the primary vendor is unavailable", async () => {
  const attempts: SimpleLlmTarget[] = [];
  const result = await executeSimpleLlmFallback(
    CEREBRAS,
    GROQ,
    async (target) => {
      attempts.push(target);
      return "fallback response";
    },
    (vendor) => vendor === "groq"
  );
  assert.equal(result, "fallback response");
  assert.deepEqual(attempts, [GROQ]);
});

test("fails before making a request when neither vendor is available", async () => {
  let requests = 0;
  await assert.rejects(
    executeSimpleLlmFallback(
      CEREBRAS,
      GROQ,
      async () => {
        requests += 1;
        return "unreachable";
      },
      () => false
    ),
    (error: unknown) =>
      error instanceof LlmRequestError &&
      error.vendor === "cerebras" &&
      error.status === undefined
  );
  assert.equal(requests, 0);
});

test("rethrows the primary failure when the fallback vendor is unavailable", async () => {
  const primaryError = new LlmRequestError("primary unavailable", {
    vendor: "cerebras",
    status: 503,
  });
  const attempts: SimpleLlmTarget[] = [];
  await assert.rejects(
    executeSimpleLlmFallback(
      CEREBRAS,
      GROQ,
      async (target) => {
        attempts.push(target);
        throw primaryError;
      },
      (vendor) => vendor === "cerebras"
    ),
    (error: unknown) => error === primaryError
  );
  assert.deepEqual(attempts, [CEREBRAS]);
});

test("propagates a failed fallback without attempting a third request", async () => {
  const attempts: SimpleLlmTarget[] = [];
  await assert.rejects(
    executeSimpleLlmFallback(
      CEREBRAS,
      GROQ,
      async (target) => {
        attempts.push(target);
        throw new LlmRequestError(`${target.vendor} failed`, {
          vendor: target.vendor,
          status: target.vendor === "cerebras" ? 503 : 401,
        });
      },
      () => true
    ),
    (error: unknown) =>
      error instanceof LlmRequestError &&
      error.vendor === "groq" &&
      error.status === 401
  );
  assert.deepEqual(attempts, [CEREBRAS, GROQ]);
});

test("switching works in the reverse Groq-to-Cerebras direction", async () => {
  const attempts: SimpleLlmTarget[] = [];
  const result = await executeSimpleLlmFallback(
    GROQ,
    CEREBRAS,
    async (target) => {
      attempts.push(target);
      if (target.vendor === "groq") {
        throw new LlmRequestError("groq unavailable", {
          vendor: "groq",
          status: 503,
        });
      }
      return "cerebras response";
    },
    () => true
  );
  assert.equal(result, "cerebras response");
  assert.deepEqual(attempts, [GROQ, CEREBRAS]);
});

test("adds the Groq-compatible JSON instruction only in JSON mode", () => {
  const args = {
    vendor: "groq" as const,
    model: GROQ.model,
    system: "Extract the requested finance evidence.",
    user: '{"message":"How is Apple doing?"}',
    maxTokens: 800,
    temperature: 0,
  };

  const jsonBody = buildLlmRequestBody(args, true);
  const jsonMessages = jsonBody.messages as { role: string; content: string }[];
  assert.match(
    jsonMessages.map((message) => message.content).join("\n"),
    /\bJSON\b/
  );
  assert.deepEqual(jsonBody.response_format, { type: "json_object" });

  const textBody = buildLlmRequestBody(args, false);
  const textMessages = textBody.messages as { role: string; content: string }[];
  assert.doesNotMatch(
    textMessages.map((message) => message.content).join("\n"),
    /Return one valid JSON object only/
  );
  assert.equal(textBody.response_format, undefined);
});

test("keeps JSON instructions valid for empty system messages and schemas", () => {
  const emptySystemBody = buildLlmRequestBody(
    {
      vendor: "groq",
      model: GROQ.model,
      messages: [{ role: "system", content: "" }],
      user: "Extract the values.",
    },
    true
  );
  const emptySystemMessages = emptySystemBody.messages as {
    role: string;
    content: string;
  }[];
  assert.equal(
    emptySystemMessages[0]?.content,
    "Return one valid JSON object only."
  );

  const schemaBody = buildLlmRequestBody(
    {
      vendor: "groq",
      model: GROQ.model,
      system: "Extract the values.",
      user: "A, B, C",
      jsonSchema: {
        name: "values",
        schema: { type: "array", items: { type: "string" } },
      },
    },
    true
  );
  const schemaMessages = schemaBody.messages as {
    role: string;
    content: string;
  }[];
  assert.match(
    schemaMessages.map((message) => message.content).join("\n"),
    /valid JSON matching the requested response schema/
  );
  assert.doesNotMatch(
    schemaMessages.map((message) => message.content).join("\n"),
    /JSON object only/
  );
});

test("falls back from an exhausted Cerebras 429 to Groq", async () => {
  const attempts: SimpleLlmTarget[] = [];
  const result = await executeSimpleLlmFallback(
    CEREBRAS,
    GROQ,
    async (target) => {
      attempts.push(target);
      if (target.vendor === "cerebras") {
        throw new LlmRequestError("rate limited", {
          vendor: "cerebras",
          status: 429,
        });
      }
      return "groq response";
    },
    () => true
  );

  assert.equal(result, "groq response");
  assert.deepEqual(attempts, [CEREBRAS, GROQ]);
});

test("real transport retries Cerebras 429 then sends Groq-compatible JSON", async () => {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({
      url,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    if (url.includes("cerebras")) {
      return new Response('{"message":"rate limited"}', {
        status: 429,
        headers: { "retry-after": "0" },
      });
    }
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: '{"prices":[],"news":[],"rankings":[]}',
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const result = await simpleLlmChatJSON<{
    prices: unknown[];
    news: unknown[];
    rankings: unknown[];
  }>(
    {
      maxTokens: 800,
      temperature: 0,
      system: "Extract the requested finance evidence.",
      user: '{"message":"How is Apple doing?"}',
    },
    {
      vendorAvailable: () => true,
      transport: {
        fetchImpl,
        apiKey: () => "test-key",
        sleep: async () => {},
      },
    }
  );

  assert.deepEqual(result, { prices: [], news: [], rankings: [] });
  assert.deepEqual(
    requests.map(({ url }) =>
      url.includes("cerebras") ? "cerebras" : "groq"
    ),
    ["cerebras", "cerebras", "cerebras", "groq"]
  );
  const groqBody = requests.at(-1)?.body;
  assert.deepEqual(groqBody?.response_format, { type: "json_object" });
  assert.match(JSON.stringify(groqBody?.messages), /\bJSON\b/);
});

test("does not mask a non-transient primary request error", async () => {
  const attempts: SimpleLlmTarget[] = [];
  await assert.rejects(
    executeSimpleLlmFallback(
      CEREBRAS,
      GROQ,
      async (target) => {
        attempts.push(target);
        throw new LlmRequestError("bad request", {
          vendor: target.vendor,
          status: 400,
        });
      },
      () => true
    ),
    (error: unknown) =>
      error instanceof LlmRequestError &&
      error.vendor === "cerebras" &&
      error.status === 400
  );
  assert.deepEqual(attempts, [CEREBRAS]);
});
