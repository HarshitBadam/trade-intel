// Shared fence-stripping JSON parse for LLM output. Factored out of groq.ts so
// BOTH transports (direct Groq AND the Langflow analysis lane, Task 6) parse
// model output identically: whichever lane produced the labels JSON, the
// downstream validation must see the same object. Kept dependency-free and
// side-effect-free (no "server-only") so it can run in a plain script too.

// Some models still wrap JSON in a ```json fence even under json_object mode;
// strip a single fenced block before parsing so a stray fence doesn't fail us.
export function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced ? fenced[1] : trimmed).trim();
}

// Parse fenced-or-plain JSON into T. Callers own schema validation of the
// result; this only guarantees "it parsed as JSON". Throws with a body snippet
// so a bad completion is diagnosable without dumping the whole payload.
export function parseFencedJson<T = unknown>(raw: string): T {
  try {
    return JSON.parse(stripJsonFences(raw)) as T;
  } catch (error) {
    throw new Error(
      `LLM JSON parse failed: ${(error as Error).message}; ` +
        `body snippet: ${raw.slice(0, 300)}`
    );
  }
}
