import { useCallback, useEffect, useRef, useState } from "react";
import { getSummary, researchDeeper } from "@/app/actions";
import type {
  ChatRequest,
  ChatTurn,
  ConversationState,
} from "@/lib/stocksage/types";
import type { ChatMessageModel } from "./ChatMessage";
import { FloatingWidgetView } from "./FloatingWidgetView";

const initialMessages: ChatMessageModel[] = [
  {
    id: "welcome",
    sender: "ai",
    text: "Hey, I’m StockSage. Ask me about a company, compare a few investments, or talk through what’s moving a market.",
  },
];

interface FloatingWidgetProps {
  isExpanded?: boolean;
  onClose?: () => void;
  onOpen?: () => void;
}

function localId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `message-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function chatHistory(messages: ChatMessageModel[]): ChatTurn[] {
  return messages
    .filter((message) => message.id !== "welcome" && !message.error)
    .map((message) => ({
      role: message.sender,
      text:
        message.sender === "ai" &&
        message.deepState?.status === "success" &&
        message.deepState.text
          ? `${message.text}\n\nDeeper research:\n${message.deepState.text}`
          : message.text,
    }));
}

export function FloatingWidget({
  isExpanded: propIsExpanded,
  onClose,
  onOpen,
}: FloatingWidgetProps) {
  const [isExpandedInternal, setIsExpandedInternal] = useState(false);
  const [messages, setMessages] =
    useState<ChatMessageModel[]>(initialMessages);
  const [inputValue, setInputValue] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [showLegal, setShowLegal] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const conversationStateRef = useRef<ConversationState | undefined>(undefined);
  const sessionIdRef = useRef<string>(localId());
  const requestInFlightRef = useRef(false);
  const researchInFlightRef = useRef(new Set<string>());
  const retryRequestsRef = useRef(new Map<string, ChatRequest>());
  const isExpanded = propIsExpanded ?? isExpandedInternal;

  const handleOpen = useCallback(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (onOpen) onOpen();
    else setIsExpandedInternal(true);
  }, [onOpen]);

  const handleClose = useCallback(() => {
    if (onClose) onClose();
    setIsExpandedInternal(false);
    requestAnimationFrame(() => previousFocusRef.current?.focus());
  }, [onClose]);

  useEffect(() => {
    document.body.style.overflow = isExpanded ? "hidden" : "unset";
    return () => {
      document.body.style.overflow = "unset";
    };
  }, [isExpanded]);

  useEffect(() => {
    if (!isExpanded) return;
    inputRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") handleClose();
      if (event.key !== "Tab") return;
      const focusable = [
        ...(dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), a[href]'
        ) ?? []),
      ];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [handleClose, isExpanded]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isThinking]);

  const submitRequest = async (
    request: ChatRequest,
    appendUserMessage: boolean
  ) => {
    if (requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    if (appendUserMessage) {
      setMessages((previous) => [
        ...previous,
        { id: localId(), sender: "user", text: request.message },
      ]);
    }
    setIsThinking(true);
    try {
      const reply = await getSummary(request);
      if (reply.state) conversationStateRef.current = reply.state;
      const messageId = reply.responseId ?? localId();
      if (reply.kind === "error") {
        if (reply.retryable) retryRequestsRef.current.set(messageId, request);
        setMessages((previous) => [
          ...previous,
          {
            id: messageId,
            sender: "ai",
            text: reply.text,
            error: true,
            retryable: reply.retryable,
            dataStatus: reply.dataStatus,
          },
        ]);
        return;
      }
      if (reply.retryable) {
        retryRequestsRef.current.set(messageId, request);
      }
      setMessages((previous) => [
        ...previous,
        {
          id: messageId,
          sender: "ai",
          text: reply.text,
          citationUrls: reply.citationUrls,
          deepResearch: reply.deepResearch,
          deepState: reply.deepResearch ? { status: "idle" } : undefined,
          retryable: reply.retryable,
          dataStatus: reply.dataStatus,
        },
      ]);
    } catch {
      const messageId = localId();
      retryRequestsRef.current.set(messageId, request);
      setMessages((previous) => [
        ...previous,
        {
          id: messageId,
          sender: "ai",
          text: "I lost the connection while answering. Your conversation is still here.",
          error: true,
          retryable: true,
        },
      ]);
    } finally {
      requestInFlightRef.current = false;
      setIsThinking(false);
    }
  };

  const sendMessage = () => {
    const text = inputValue.trim();
    if (!text || requestInFlightRef.current) return;
    const request: ChatRequest = {
      message: text,
      sessionId: sessionIdRef.current,
      history: chatHistory(messages),
      state: conversationStateRef.current,
    };
    setInputValue("");
    void submitRequest(request, true);
  };

  const retryMessage = (messageId: string) => {
    const request = retryRequestsRef.current.get(messageId);
    if (!request || requestInFlightRef.current) return;
    retryRequestsRef.current.delete(messageId);
    setMessages((previous) =>
      previous.filter((message) => message.id !== messageId)
    );
    void submitRequest(request, false);
  };

  const runResearch = async (messageId: string) => {
    const target = messages.find((message) => message.id === messageId);
    if (
      !target?.deepResearch ||
      !target.deepResearch.available ||
      target.deepState?.status === "pending" ||
      researchInFlightRef.current.has(messageId)
    ) {
      return;
    }
    researchInFlightRef.current.add(messageId);
    setMessages((previous) =>
      previous.map((message) =>
        message.id === messageId
          ? {
              ...message,
              deepState: {
                status: "pending",
                progress: "Researching sources",
              },
            }
          : message
      )
    );
    try {
      const result = await researchDeeper(target.deepResearch.token);
      setMessages((previous) =>
        previous.map((message) =>
          message.id === messageId
            ? {
                ...message,
                deepState: {
                  status: result.status,
                  text: result.text,
                  citationUrls: result.citationUrls,
                  retryable: result.retryable,
                },
              }
            : message
        )
      );
    } catch {
      setMessages((previous) =>
        previous.map((message) =>
          message.id === messageId
            ? {
                ...message,
                deepState: {
                  status: "failure",
          text: "The deeper report isn’t available right now, the answer above remains in place; try again shortly.",
                  retryable: true,
                },
              }
            : message
        )
      );
    } finally {
      researchInFlightRef.current.delete(messageId);
    }
  };

  return (
    <FloatingWidgetView
      isExpanded={isExpanded}
      handleOpen={handleOpen}
      handleClose={handleClose}
      dialogRef={dialogRef}
      messages={messages}
      runResearch={runResearch}
      retryMessage={retryMessage}
      isThinking={isThinking}
      chatEndRef={chatEndRef}
      inputRef={inputRef}
      inputValue={inputValue}
      setInputValue={setInputValue}
      sendMessage={sendMessage}
      showLegal={showLegal}
      setShowLegal={setShowLegal}
    />
  );
}
