import "server-only";

import { LANGFLOW_ANALYZE_FLOW_ID } from "@/lib/config";
import { runLangflowFlow } from "@/lib/langflow";

/**
 * Explicit manual/evaluation adapter for comparing the retained analysis flow
 * with direct Groq. Production analysis and StockSage never import this file.
 */
export class LangflowAnalysisProvider {
  constructor(private readonly flowId = LANGFLOW_ANALYZE_FLOW_ID) {}

  get configured(): boolean {
    return Boolean(this.flowId);
  }

  async analyze(input: string, timeoutMs = 55_000): Promise<string> {
    if (!this.flowId) {
      throw new Error("LANGFLOW_ANALYZE_FLOW_ID is not configured");
    }
    return runLangflowFlow({
      flowId: this.flowId,
      input,
      timeoutMs,
    });
  }
}
