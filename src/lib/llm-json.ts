// Some models wrap JSON in a ```json fence even under json_object mode;
// strip it before parsing so a stray fence doesn't fail us.
export function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced ? fenced[1] : trimmed).trim();
}

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
