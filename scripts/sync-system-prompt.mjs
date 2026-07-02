import { readFileSync, writeFileSync } from "node:fs";

const promptPath = new URL("../src/lib/stocksage/system-prompt.json", import.meta.url);
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
