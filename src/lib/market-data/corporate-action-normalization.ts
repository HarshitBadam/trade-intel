import "server-only";

import type { CorporateAction } from "./security-master-types";

function actionIdentity(action: CorporateAction): string {
  return [
    "action",
    action.ticker.toUpperCase(),
    action.kind,
    action.exDate,
    action.ratio === undefined ? "" : String(action.ratio),
    action.amount === undefined ? "" : String(action.amount),
    action.currency ?? "",
    action.fromSymbol ?? "",
    action.toSymbol ?? "",
  ]
    .map(encodeURIComponent)
    .join(":");
}

export function normalizeCorporateActions(
  actions: readonly CorporateAction[]
): CorporateAction[] {
  const normalized = new Map<string, CorporateAction>();
  for (const action of actions) {
    const ticker = action.ticker.trim().toUpperCase();
    if (
      !ticker ||
      !/^\d{4}-\d{2}-\d{2}$/.test(action.exDate) ||
      (action.ratio !== undefined &&
        (!Number.isFinite(action.ratio) || action.ratio <= 0)) ||
      (action.amount !== undefined && !Number.isFinite(action.amount))
    ) {
      continue;
    }
    const candidate = { ...action, ticker };
    const id = actionIdentity(candidate);
    normalized.set(id, { ...candidate, id });
  }
  return [...normalized.values()].sort(
    (left, right) =>
      left.exDate.localeCompare(right.exDate) ||
      left.kind.localeCompare(right.kind) ||
      left.id.localeCompare(right.id)
  );
}
