import { readFileSync, writeFileSync } from "node:fs";

// Re-bake the app's canonical analysis instructions into the retained
// manual/evaluation-only Langflow analysis flow.

const root = new URL("../", import.meta.url);

// The instructions live as a TS line array; extract it without importing TS.
const analysisPromptPath = new URL("src/lib/stocksage/analysis-prompt.ts", root);
const analysisFlowPath = new URL("langflow/stocksage-analysis.json", root);

const tsSrc = readFileSync(analysisPromptPath, "utf8");
const match = tsSrc.match(/ANALYSIS_INSTRUCTION_LINES: string\[\] = (\[[\s\S]*?\]);/);
if (!match) throw new Error("could not extract ANALYSIS_INSTRUCTION_LINES from analysis-prompt.ts");
const analysisLines = eval(match[1]);
const analysisInstructions = analysisLines.join("\n");
// Langflow's Prompt component parses every `{...}` in the template as a
// variable, so a stray brace in the instruction text breaks the flow at build
// time ("Error building Component Analysis Prompt"). Only `{payload}` (added
// below) may exist. Fail loudly rather than bake a broken template.
if (/[{}]/.test(analysisInstructions)) {
  throw new Error(
    "analysis instructions must not contain '{' or '}' — Langflow's Prompt " +
      "node would treat them as template variables; describe JSON in words"
  );
}
// The Prompt node keeps the {payload} variable after the shared instructions.
const analysisTemplate = `${analysisInstructions}\n\n{payload}`;

const analysisFlow = JSON.parse(readFileSync(analysisFlowPath, "utf8"));
const analysisNodes = analysisFlow?.data?.nodes ?? [];
const prompt = analysisNodes.find((n) => String(n.data?.type) === "Prompt");
if (!prompt) throw new Error("Prompt node not found in analysis flow");
const promptField = prompt?.data?.node?.template?.template;
if (!promptField) throw new Error("template field not found on analysis Prompt node");
const analysisBefore = promptField.value;
promptField.value = analysisTemplate;
writeFileSync(analysisFlowPath, JSON.stringify(analysisFlow, null, 2) + "\n");

console.log(
  `Baked analysis prompt into Langflow flow:\n` +
    `  template on ${prompt.data.id}: ${analysisBefore?.length ?? 0} -> ${analysisTemplate.length} chars`
);
