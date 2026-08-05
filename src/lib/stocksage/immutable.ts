/**
 * Recursively freezes an object graph the caller owns exclusively — every
 * plain object and array reachable from `value`. Used to harden the frozen
 * `Turn` contract (`types.ts`) so nested collections (`context.entities`,
 * `context.state.entities/groups/intervals`, ...) cannot be mutated in place
 * once a turn is finalized, matching the top-level `Object.freeze` that was
 * already applied to `turn`, `turn.decision`, and `turn.context`.
 *
 * Must only be called on data the engine itself built (e.g. the output of
 * `sanitizeConversationState`/`resolveTurnContext`, which always produce
 * fresh arrays and entity objects) — never on a caller-owned `ChatRequest`
 * or its `history`/`state`, since those are not this module's to lock.
 */
export function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || typeof value !== "object") return value;
  // Track visited objects instead of short-circuiting on `Object.isFrozen`:
  // some inputs (e.g. `TurnContext`, already `Object.freeze`d one level deep
  // at construction) are frozen at the top but still have unfrozen nested
  // arrays/objects that still need recursing into.
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key], seen);
  }
  Object.freeze(value);
  return value;
}
