// Bakes the canonical StockSage system prompt (src/lib/stocksage-system-prompt.json)
// into the chat flow's embedded Language Model `system_message`.
//
// Why: the hosted Langflow version ignores a `system_message` tweak sent to the
// LLM node at run time, so the only prompt the model actually obeys is the one
// saved inside the flow. This keeps that embedded prompt in sync with the JSON
// source of truth without hand-editing the 3000-line flow export.
//
// Usage:  node scripts/sync-system-prompt.mjs
// Then re-import langflow/stocksage-chat.json into your Langflow Space.

import { readFileSync, writeFileSync } from "node:fs";

const promptPath = new URL("../src/lib/stocksage-system-prompt.json", import.meta.url);
const flowPath = new URL("../langflow/stocksage-chat.json", import.meta.url);

const lines = JSON.parse(readFileSync(promptPath, "utf8"));
if (!Array.isArray(lines)) throw new Error("prompt JSON must be an array of strings");
const system = lines.join("\n");

const flow = JSON.parse(readFileSync(flowPath, "utf8"));
const nodes = flow?.data?.nodes ?? [];
const llm = nodes.find((n) => String(n.id).startsWith("LanguageModel"));
if (!llm) throw new Error("Language Model node not found in flow");

const tmpl = llm?.data?.node?.template ?? {};
if (!tmpl.system_message) throw new Error("system_message field not found on LLM node");

const before = tmpl.system_message.value;
tmpl.system_message.value = system;

writeFileSync(flowPath, JSON.stringify(flow, null, 2) + "\n");
console.log(
  `Baked system prompt into ${flowPath.pathname}\n` +
    `  node: ${llm.id}\n` +
    `  chars: ${before?.length ?? 0} -> ${system.length}`
);
