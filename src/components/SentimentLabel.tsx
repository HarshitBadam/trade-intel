/**
 * Renders a sentiment string with a small colored dot instead of an emoji, so
 * it matches the rest of the UI's flat aesthetic. The tone (color) is inferred
 * from the text ("bull" → positive, "bear" → negative, else neutral) and any
 * leading emoji is stripped.
 */

function toneFor(text: string): { dot: string; label: string } {
  const cleaned = text.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "").trim();
  const lower = cleaned.toLowerCase();
  if (lower.includes("bull") || lower.includes("positive")) {
    return { dot: "bg-green-600", label: cleaned };
  }
  if (lower.includes("bear") || lower.includes("negative")) {
    return { dot: "bg-red-700", label: cleaned };
  }
  return { dot: "bg-gray-400", label: cleaned };
}

export function SentimentLabel({
  sentiment,
  className = "",
}: {
  sentiment: string;
  className?: string;
}) {
  const { dot, label } = toneFor(sentiment);
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      {label}
    </span>
  );
}
