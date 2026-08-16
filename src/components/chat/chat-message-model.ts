import type {
  ChatPresentationMode,
  ChatTurn,
} from "@/lib/stocksage/types";

export type ChatMessageVersion = {
  text: string;
  citationUrls?: string[];
  error?: boolean;
  presentationMode?: ChatPresentationMode;
};

export type ChatMessageModel = {
  id: string;
  sender: "ai" | "user";
  versions: [ChatMessageVersion, ...ChatMessageVersion[]];
  activeVersionIndex: number;
  canRegenerate?: boolean;
};

export function createChatMessage(
  id: string,
  sender: ChatMessageModel["sender"],
  version: ChatMessageVersion,
  canRegenerate = false
): ChatMessageModel {
  return {
    id,
    sender,
    versions: [version],
    activeVersionIndex: 0,
    ...(canRegenerate ? { canRegenerate: true } : {}),
  };
}

export function activeChatMessageVersion(
  message: ChatMessageModel
): ChatMessageVersion {
  return (
    message.versions[message.activeVersionIndex] ??
    message.versions[message.versions.length - 1]
  );
}

export function appendChatMessageVersion(
  messages: ChatMessageModel[],
  messageId: string,
  version: ChatMessageVersion,
  canRegenerate = false
): ChatMessageModel[] {
  return messages.map((message) =>
    message.id === messageId
      ? {
          ...message,
          versions: [...message.versions, version],
          activeVersionIndex: message.versions.length,
          canRegenerate: message.canRegenerate || canRegenerate || undefined,
        }
      : message
  );
}

export function selectChatMessageVersion(
  messages: ChatMessageModel[],
  messageId: string,
  versionIndex: number
): ChatMessageModel[] {
  return messages.map((message) =>
    message.id === messageId &&
    versionIndex >= 0 &&
    versionIndex < message.versions.length
      ? { ...message, activeVersionIndex: versionIndex }
      : message
  );
}

export function chatHistory(messages: ChatMessageModel[]): ChatTurn[] {
  return messages
    .filter(
      (message) =>
        message.id !== "welcome" && !activeChatMessageVersion(message).error
    )
    .map((message) => ({
      role: message.sender,
      text: activeChatMessageVersion(message).text,
    }));
}
