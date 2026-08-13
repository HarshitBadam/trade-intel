import { WEB_ALIASES } from "../entity/entity-catalog";
import { fromAlias, resolveText } from "../entity/entity-resolution";
import {
  NARROWING_TO_SUBSET,
  REMOVAL,
  SWAP_CORRECTION,
  SWAP_IN_CORRECTION,
  lastAssistantMentionCounts,
  removalTargets,
  subsetKeepCount,
} from "../entity/entity-state-helpers";
import type { ChatTurn, ConversationState, FinanceEntity } from "../types";

export type CorrectionResolution = {
  direct: FinanceEntity[];
  removed: FinanceEntity[];
  correctedBase: FinanceEntity[];
  correctedExplicitSet: string[];
  fortuneReplacement: boolean;
};

export function resolveCorrections(args: {
  message: string;
  commandMessage: string;
  base: ConversationState;
  history: ChatTurn[];
}): CorrectionResolution {
  const { message, commandMessage, base, history } = args;
  let direct = resolveText(message);
  const fortuneReplacement =
    /\b(?:wb|what about)\s+(?:the\s+)?100\b/i.test(message) &&
    base.entities.some((entity) => entity.name === "Fortune 500");
  if (fortuneReplacement) {
    const fortune100 = WEB_ALIASES.find((alias) => alias.name === "Fortune 100");
    direct = fortune100 ? [fromAlias(fortune100)] : direct;
  }

  const meantCorrection = message.match(
    /\bi meant\s+(.+?)(?:,|\s)\s*not\s+(.+?)(?:[.!?]|$)/i
  );
  const replacementCorrection = message.match(
    /\bnot\s+(.+?)(?:,|\s+but\s+|\s+instead\s+)(.+?)(?:[.!?]|$)/i
  );
  const swapIn = commandMessage.match(SWAP_IN_CORRECTION);
  const swap = swapIn ? null : commandMessage.match(SWAP_CORRECTION);
  let removed = meantCorrection
    ? resolveText(meantCorrection[2])
    : replacementCorrection
      ? resolveText(replacementCorrection[1])
      : swapIn
        ? resolveText(swapIn[2])
        : swap
          ? resolveText(swap[1])
          : [];

  if (removed.length === 0) {
    const removalMatch = commandMessage.match(REMOVAL);
    if (removalMatch) {
      removed = removalTargets(removalMatch[1], base.entities);
    }
  }

  if (
    removed.length === 0 &&
    base.entities.length > 2 &&
    NARROWING_TO_SUBSET.test(commandMessage)
  ) {
    const counts = lastAssistantMentionCounts(base.entities, history);
    const mentioned = base.entities.filter(
      (entity) => (counts.get(entity.id) ?? 0) > 0
    );
    if (mentioned.length > 0 && mentioned.length < base.entities.length) {
      const keepCount = Math.min(subsetKeepCount(message), mentioned.length);
      const keepIds = new Set(
        [...mentioned]
          .sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0))
          .slice(0, keepCount)
          .map((entity) => entity.id)
      );
      removed = base.entities.filter((entity) => !keepIds.has(entity.id));
    }
  }

  // Listing clarifications can resolve both sides to one canonical company.
  if (
    removed.length > 0 &&
    direct.length > 0 &&
    direct.every((entity) =>
      removed.some((candidate) => candidate.id === entity.id)
    )
  ) {
    removed = [];
  }

  let correctedBase = base.entities;
  let correctedExplicitSet = base.explicitEntitySet;
  if (removed.length > 0) {
    const removedIds = new Set(removed.map((entity) => entity.id));
    direct = direct.filter((entity) => !removedIds.has(entity.id));
    const insertionIndex = base.entities.findIndex((entity) =>
      removedIds.has(entity.id)
    );
    correctedBase = base.entities.filter(
      (entity) => !removedIds.has(entity.id)
    );
    correctedBase.splice(
      insertionIndex >= 0 ? insertionIndex : correctedBase.length,
      0,
      ...direct
    );
    correctedBase = [
      ...new Map(correctedBase.map((entity) => [entity.id, entity])).values(),
    ];
    const replacementIds = direct.map((entity) => entity.id);
    correctedExplicitSet = [
      ...new Set(
        base.explicitEntitySet.flatMap((id) =>
          removedIds.has(id) ? replacementIds : [id]
        )
      ),
    ];
  }

  return {
    direct,
    removed,
    correctedBase,
    correctedExplicitSet,
    fortuneReplacement,
  };
}
