import { canonicalizeEntity, groupMembers, resolveGroupRefs, resolveText } from "./entity-resolution";
import { sanitizeConversationState } from "./state";
import type { ChatTurn, ConversationState } from "./types";

export function emptyConversationState(): ConversationState {
  return {
    version: 1,
    revision: 0,
    entities: [],
    explicitEntitySet: [],
    criteria: [],
  };
}

function stateFromHistory(history: ChatTurn[]): ConversationState {
  let state = emptyConversationState();
  for (const turn of history) {
    if (turn.role !== "user") continue;
    const entities = [
      ...resolveText(turn.text),
      ...groupMembers(resolveGroupRefs(turn.text)),
    ];
    if (entities.length === 0) continue;
    const unique = [
      ...new Map(entities.map((entity) => [entity.id, entity])).values(),
    ];
    state = {
      ...state,
      revision: state.revision + 1,
      entities: unique,
      explicitEntitySet: unique.map((entity) => entity.id),
    };
  }
  return state;
}

export function baseConversationState(
  previous: ConversationState | undefined,
  history: ChatTurn[]
): ConversationState {
  return previous
    ? sanitizeConversationState(previous, canonicalizeEntity)
    : stateFromHistory(history);
}
