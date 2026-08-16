import { useEffect, useRef } from "react";
import { ChatMessage } from "./ChatMessage";
import type { ChatMessageModel } from "./chat-message-model";
import styles from "./FloatingWidget.module.css";

type ChatTranscriptProps = {
  messages: ChatMessageModel[];
  onRetry: (messageId: string) => void;
  onSelectVersion: (messageId: string, versionIndex: number) => void;
  isThinking: boolean;
  pendingMessageId: string | null;
  followLatest: boolean;
};

function scrollMessageToReadingPosition(
  viewport: HTMLDivElement,
  message: HTMLDivElement,
  onlyIfClipped = false
) {
  const padding = 8;
  const viewportRect = viewport.getBoundingClientRect();
  const messageRect = message.getBoundingClientRect();
  const fullyVisible =
    messageRect.top >= viewportRect.top + padding &&
    messageRect.bottom <= viewportRect.bottom - padding;
  if (onlyIfClipped && fullyVisible) return;
  const availableHeight = viewportRect.height - padding * 2;
  const top =
    messageRect.height > availableHeight
      ? viewport.scrollTop + messageRect.top - viewportRect.top - padding
      : viewport.scrollTop +
        messageRect.bottom -
        viewportRect.bottom +
        padding;
  viewport.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}

function WorkingIndicator() {
  return (
    <div
      className="flex max-w-full justify-start"
      role="status"
      aria-live="polite"
    >
      <div className="max-w-xs animate-pulse rounded-lg p-3 text-muted-foreground">
        Working on that.
      </div>
    </div>
  );
}

export function ChatTranscript({
  messages,
  onRetry,
  onSelectVersion,
  isThinking,
  pendingMessageId,
  followLatest,
}: ChatTranscriptProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef(new Map<string, HTMLDivElement>());
  const lastPendingMessageIdRef = useRef<string | null>(null);
  const versionIndexesRef = useRef(
    new Map(messages.map((message) => [message.id, message.activeVersionIndex]))
  );

  useEffect(() => {
    if (!followLatest) return;
    const frame = requestAnimationFrame(() => {
      const latestMessage = messages[messages.length - 1];
      if (isThinking && latestMessage?.sender === "user") {
        endRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
        });
        return;
      }
      const viewport = scrollRef.current;
      const message = latestMessage
        ? messageRefs.current.get(latestMessage.id)
        : undefined;
      if (viewport && message) {
        scrollMessageToReadingPosition(viewport, message);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [followLatest, isThinking, messages]);

  useEffect(() => {
    const changedMessage = messages.find(
      (message) =>
        versionIndexesRef.current.has(message.id) &&
        versionIndexesRef.current.get(message.id) !==
          message.activeVersionIndex
    );
    versionIndexesRef.current = new Map(
      messages.map((message) => [message.id, message.activeVersionIndex])
    );
    if (
      !changedMessage ||
      lastPendingMessageIdRef.current === changedMessage.id
    ) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      const viewport = scrollRef.current;
      const message = messageRefs.current.get(changedMessage.id);
      if (viewport && message) {
        scrollMessageToReadingPosition(viewport, message);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [messages]);

  useEffect(() => {
    const messageId = pendingMessageId ?? lastPendingMessageIdRef.current;
    lastPendingMessageIdRef.current = pendingMessageId;
    if (!messageId) return;
    const frame = requestAnimationFrame(() => {
      const viewport = scrollRef.current;
      const message = messageRefs.current.get(messageId);
      if (!viewport || !message) return;
      scrollMessageToReadingPosition(viewport, message, true);
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, pendingMessageId]);

  return (
    <div ref={scrollRef} className="flex-1 scroll-smooth overflow-y-scroll">
      <div className={styles.chatContent}>
        {messages.map((message) => (
          <div
            key={message.id}
            ref={(node) => {
              if (node) messageRefs.current.set(message.id, node);
              else messageRefs.current.delete(message.id);
            }}
          >
            <ChatMessage
              message={message}
              onRetry={onRetry}
              onSelectVersion={onSelectVersion}
              retryDisabled={isThinking}
            />
            {pendingMessageId === message.id && <WorkingIndicator />}
          </div>
        ))}
        {isThinking && !pendingMessageId && <WorkingIndicator />}
        <div ref={endRef} />
      </div>
    </div>
  );
}
