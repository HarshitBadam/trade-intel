import type { ConversationState, FinanceEntity } from "../types";

export type OrderedReferenceResolution =
  | {
      status: "resolved";
      direct: FinanceEntity[];
      subsetMatch: boolean;
      orderedMatch: boolean;
      orderedPivot: boolean;
    }
  | {
      status: "clarification";
      clarification: string;
      reasonCode:
        | "ambiguous_ordered_reference"
        | "stale_ordered_reference";
    };

export function resolveOrderedReferences(args: {
  commandMessage: string;
  base: ConversationState;
  direct: FinanceEntity[];
}): OrderedReferenceResolution {
  const direct = [...args.direct];
  const byId = new Map(
    args.base.entities.map((entity) => [entity.id, entity])
  );
  const subsetMatch = args.commandMessage.match(
    /\b(?:only\s+)?the\s+(former|latter)\s+two\b/i
  );
  const orderedMatches = [
    ...args.commandMessage.matchAll(
      /\b(former|latter|first one|second one)\b/gi
    ),
  ];
  const orderedMatch = orderedMatches.length > 0;
  let orderedPivot = false;

  if (subsetMatch) {
    if (args.base.explicitEntitySet.length < 2) {
      return {
        status: "clarification",
        clarification:
          "Which companies do you mean? Name the group before asking for a subset.",
        reasonCode: "ambiguous_ordered_reference",
      };
    }
    const useFormer = /former/i.test(subsetMatch[1]);
    const ids = useFormer
      ? args.base.explicitEntitySet.slice(0, 2)
      : args.base.explicitEntitySet.slice(-2);
    direct.unshift(
      ...ids
        .map((id) => byId.get(id))
        .filter((entity): entity is FinanceEntity => Boolean(entity))
    );
  } else if (orderedMatch) {
    if (args.base.explicitEntitySet.length !== 2) {
      return {
        status: "clarification",
        clarification:
          "Which two entities do you mean? Name them in order so I can resolve former and latter.",
        reasonCode: "ambiguous_ordered_reference",
      };
    }
    const ids = [
      ...new Set(
        orderedMatches.map((match) =>
          /former|first/i.test(match[1])
            ? args.base.explicitEntitySet[0]
            : args.base.explicitEntitySet[1]
        )
      ),
    ];
    const resolved = ids
      .map((id) => byId.get(id))
      .filter((entity): entity is FinanceEntity => Boolean(entity));
    if (resolved.length !== ids.length) {
      return {
        status: "clarification",
        clarification: "Please name the entity you mean.",
        reasonCode: "stale_ordered_reference",
      };
    }
    orderedPivot = direct.length > 0;
    direct.unshift(...resolved);
  }

  return {
    status: "resolved",
    direct,
    subsetMatch: Boolean(subsetMatch),
    orderedMatch,
    orderedPivot,
  };
}
