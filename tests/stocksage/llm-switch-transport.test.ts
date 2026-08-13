import "../no-live-keys";
import assert from "node:assert/strict";
import test from "node:test";
import {
  LlmJsonParseError,
  LlmRequestError,
} from "../../src/lib/llm";
import {
  simpleLlmChatJSON,
  simpleLlmChatText,
} from "../../src/lib/stocksage/simple/llm";

type CapturedRequest = {
  vendor: "cerebras" | "groq";
  body: Record<string, unknown>;
};

function completion(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function capturedRequest(
  input: string | URL | Request,
  init: RequestInit | undefined
): CapturedRequest {
  const url = String(input);
  return {
    vendor: url.includes("cerebras") ? "cerebras" : "groq",
    body: JSON.parse(String(init?.body)) as Record<string, unknown>,
  };
}

const dependencies = (fetchImpl: typeof fetch) => ({
  vendorAvailable: () => true,
  transport: {
    fetchImpl,
    apiKey: () => "test-key",
    sleep: async () => {},
  },
});

test("malformed primary JSON switches providers and returns valid fallback JSON", async () => {
  const requests: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = capturedRequest(input, init);
    requests.push(request);
    return request.vendor === "cerebras"
      ? completion("not valid JSON")
      : completion('{"ok":true}');
  };

  const result = await simpleLlmChatJSON<{ ok: boolean }>(
    { system: "Return data.", user: "Request", maxTokens: 100 },
    dependencies(fetchImpl)
  );

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(
    requests.map((request) => request.vendor),
    ["cerebras", "groq"]
  );
  assert.equal(
    requests.every(
      (request) =>
        (request.body.response_format as { type?: string })?.type ===
        "json_object"
    ),
    true
  );
});

test("text mode switches after primary retries without enabling JSON mode", async () => {
  const requests: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = capturedRequest(input, init);
    requests.push(request);
    return request.vendor === "cerebras"
      ? new Response("temporary failure", { status: 503 })
      : completion("fallback text");
  };

  const result = await simpleLlmChatText(
    { system: "Answer directly.", user: "Request", maxTokens: 100 },
    dependencies(fetchImpl)
  );

  assert.equal(result, "fallback text");
  assert.deepEqual(
    requests.map((request) => request.vendor),
    ["cerebras", "cerebras", "cerebras", "groq"]
  );
  assert.equal(
    requests.every((request) => request.body.response_format === undefined),
    true
  );
});

test("a primary network failure switches immediately to the fallback", async () => {
  const vendors: Array<"cerebras" | "groq"> = [];
  const fetchImpl: typeof fetch = async (input) => {
    const vendor = String(input).includes("cerebras") ? "cerebras" : "groq";
    vendors.push(vendor);
    if (vendor === "cerebras") throw new TypeError("socket closed");
    return completion("fallback text");
  };

  const result = await simpleLlmChatText(
    { user: "Request" },
    dependencies(fetchImpl)
  );

  assert.equal(result, "fallback text");
  assert.deepEqual(vendors, ["cerebras", "groq"]);
});

test("a malformed primary response envelope switches to the fallback", async () => {
  const vendors: Array<"cerebras" | "groq"> = [];
  const fetchImpl: typeof fetch = async (input) => {
    const vendor = String(input).includes("cerebras") ? "cerebras" : "groq";
    vendors.push(vendor);
    return vendor === "cerebras"
      ? new Response('{"choices":', {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      : completion("fallback text");
  };

  const result = await simpleLlmChatText(
    { user: "Request" },
    dependencies(fetchImpl)
  );

  assert.equal(result, "fallback text");
  assert.deepEqual(vendors, ["cerebras", "groq"]);
});

test("malformed response envelopes from both providers report the fallback vendor", async () => {
  const vendors: Array<"cerebras" | "groq"> = [];
  const fetchImpl: typeof fetch = async (input) => {
    const vendor = String(input).includes("cerebras") ? "cerebras" : "groq";
    vendors.push(vendor);
    return new Response('{"choices":', { status: 200 });
  };

  await assert.rejects(
    simpleLlmChatText({ user: "Request" }, dependencies(fetchImpl)),
    (error: unknown) =>
      error instanceof LlmRequestError &&
      error.vendor === "groq" &&
      error.status === undefined
  );
  assert.deepEqual(vendors, ["cerebras", "groq"]);
});

test("malformed JSON from both providers propagates the fallback parse error", async () => {
  let requests = 0;
  const fetchImpl: typeof fetch = async () => {
    requests += 1;
    return completion("still not JSON");
  };

  await assert.rejects(
    simpleLlmChatJSON({ user: "Request" }, dependencies(fetchImpl)),
    (error: unknown) => error instanceof LlmJsonParseError
  );
  assert.equal(requests, 2);
});

test("a permanent primary HTTP error never calls the fallback transport", async () => {
  const vendors: Array<"cerebras" | "groq"> = [];
  const fetchImpl: typeof fetch = async (input) => {
    const vendor = String(input).includes("cerebras") ? "cerebras" : "groq";
    vendors.push(vendor);
    return new Response("unauthorized", { status: 401 });
  };

  await assert.rejects(
    simpleLlmChatText({ user: "Request" }, dependencies(fetchImpl)),
    (error: unknown) =>
      error instanceof LlmRequestError &&
      error.vendor === "cerebras" &&
      error.status === 401
  );
  assert.deepEqual(vendors, ["cerebras"]);
});
