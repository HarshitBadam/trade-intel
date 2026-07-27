export function humanAsOf(asOf: string): string {
  if (!asOf.includes("T")) return asOf;
  const parsed = new Date(asOf);
  if (Number.isNaN(parsed.getTime())) return asOf.split("T")[0];
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/New_York",
  }).format(parsed);
}

export function humanPublishedAt(value: string): string {
  if (!value.includes("T")) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value.split("T")[0];
  const sameYear = parsed.getUTCFullYear() === new Date().getUTCFullYear();
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
    timeZone: "America/New_York",
  }).format(parsed);
}
