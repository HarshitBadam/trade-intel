import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkDeepResearch,
  getSummary,
  researchDeeper,
  retryResearchDeeper,
} from "@/app/actions";
import type {
  ChatRequest,
  ChatTurn,
  ClarificationChoice,
  ConversationState,
} from "@/lib/stocksage/types";
import type { ChatMessageModel } from "./ChatMessage";
import {
  cancellableDelay,
  deepPollDelayMs,
  nextDeepPollAction,
} from "./deep-polling";
import { FloatingWidgetView } from "./FloatingWidgetView";
import { nextDeepAction } from "./presentation";

const UNRESOLVED_WORK_ID = new Set(["unavailable", "invalid"]);

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
  const [isClosing, setIsClosing] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const conversationStateRef = useRef<ConversationState | undefined>(undefined);
  const sessionIdRef = useRef<string>(localId());
  const requestInFlightRef = useRef(false);
  const researchInFlightRef = useRef(new Set<string>());
  const researchAbortRef = useRef(new Map<string, AbortController>());
  const retryRequestsRef = useRef(new Map<string, ChatRequest>());
  const isMountedRef = useRef(true);
  const isExpanded = propIsExpanded ?? isExpandedInternal;

  // Every async path below (submitRequest, runResearch) checks this before
  // touching state, and every in-flight Deep Research poll loop checks its
  // own AbortController, so nothing calls setState or schedules another
  // fetch after the widget has unmounted.
  useEffect(() => {
    isMountedRef.current = true;
    const pendingResearch = researchAbortRef.current;
    return () => {
      isMountedRef.current = false;
      for (const controller of pendingResearch.values()) {
        controller.abort();
      }
      pendingResearch.clear();
    };
  }, []);

  const handleOpen = useCallback(() => {
    if (isClosing) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (onOpen) onOpen();
    else setIsExpandedInternal(true);
  }, [isClosing, onOpen]);

  const handleClose = useCallback(() => {
    setIsClosing(true);
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
      if (!isMountedRef.current) return;
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
          presentationMode: reply.presentationMode,
          presentationReason: reply.presentationReason,
          clarificationChoices: reply.clarificationChoices,
        },
      ]);
    } catch {
      if (!isMountedRef.current) return;
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
      if (isMountedRef.current) setIsThinking(false);
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

  /**
   * Selecting a clarification choice submits its label as the next user
   * turn through the same `submitRequest` path as free-text input — the
   * same session, history, and conversation state, with no parallel
   * clarification-tracking state. Marking `clarificationSelectedId`
   * synchronously (before the network call resolves) stops a second click
   * from submitting the same choice twice.
   */
  const submitClarification = (
    messageId: string,
    choice: ClarificationChoice
  ) => {
    if (requestInFlightRef.current) return;
    const target = messages.find((message) => message.id === messageId);
    if (!target || target.clarificationSelectedId) return;
    setMessages((previous) =>
      previous.map((message) =>
        message.id === messageId
          ? { ...message, clarificationSelectedId: choice.id }
          : message
      )
    );
    const request: ChatRequest = {
      message: choice.label,
      sessionId: sessionIdRef.current,
      history: chatHistory(messages),
      state: conversationStateRef.current,
    };
    void submitRequest(request, true);
  };

  const runResearch = async (messageId: string) => {
    const target = messages.find((message) => message.id === messageId);
    const action = nextDeepAction(target?.deepState?.status);
    if (
      !target?.deepResearch ||
      !target.deepResearch.available ||
      action === "blocked" ||
      researchInFlightRef.current.has(messageId)
    ) {
      return;
    }
    researchInFlightRef.current.add(messageId);
    const controller = new AbortController();
    researchAbortRef.current.set(messageId, controller);
    const { signal } = controller;
    const setIfLive = (updater: (previous: ChatMessageModel[]) => ChatMessageModel[]) => {
      if (!isMountedRef.current || signal.aborted) return;
      setMessages(updater);
    };
    setIfLive((previous) =>
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
      const token = target.deepResearch.token;
      // A retry click reissues a brand-new signed work/attempt identity
      // server-side rather than replaying the original offer token, so a
      // retry never collides with (or gets deduplicated against) the
      // attempt it is replacing.
      let job =
        action === "retry"
          ? await retryResearchDeeper(token)
          : await researchDeeper(token);
      if (signal.aborted) return;
      let currentWorkId =
        job.status === "pending" ? job.workId : job.reply.workId;
      // The work runs on a durable queue, so the widget waits by polling
      // with a bounded backoff instead of holding the server action open or
      // hammering the poll endpoint at a fixed interval. The regular answer
      // stays visible throughout. A `rate_limited` denial — either the
      // initial admission or a later poll — is a transient "try again
      // shortly" signal distinct from a real job outcome, so it retries the
      // same work instead of settling as a definite failure; only
      // `unauthorized` and an actual terminal job result stop the loop.
      let waitedMs = 0;
      let attempt = 0;
      while (!signal.aborted) {
        const errorCode = job.status === "failure" ? job.reply.errorCode : undefined;
        const retryAfterMs =
          job.status === "failure" ? job.reply.retryAfterMs : undefined;
        const decision = nextDeepPollAction({
          status: job.status,
          errorCode,
          retryAfterMs,
          waitedMs,
          attempt,
        });
        if (decision.action === "stop") break;
        const delayMs =
          decision.action === "retry" ? decision.delayMs : deepPollDelayMs(attempt);
        await cancellableDelay(delayMs, signal);
        if (signal.aborted) return;
        waitedMs += delayMs;
        attempt += 1;
        const hasResolvedWorkId = !UNRESOLVED_WORK_ID.has(currentWorkId);
        job = hasResolvedWorkId
          ? await checkDeepResearch(currentWorkId)
          : action === "retry"
            ? await retryResearchDeeper(token)
            : await researchDeeper(token);
        if (signal.aborted) return;
        const nextWorkId = job.status === "pending" ? job.workId : job.reply.workId;
        if (!UNRESOLVED_WORK_ID.has(nextWorkId)) currentWorkId = nextWorkId;
      }
      if (signal.aborted) return;
      const settled =
        job.status === "pending"
          ? {
              status: "failure" as const,
              text: "That deeper pass is still running in the background and taking longer than expected. The answer above still stands; run it again for a fresh attempt when you're ready.",
              retryable: true,
              timedOut: true,
            }
          : {
              status: job.reply.status,
              text: job.reply.text,
              citationUrls: job.reply.citationUrls,
              retryable: job.reply.retryable,
            };
      setIfLive((previous) =>
        previous.map((message) =>
          message.id === messageId
            ? { ...message, deepState: settled }
            : message
        )
      );
    } catch {
      if (signal.aborted) return;
      setIfLive((previous) =>
        previous.map((message) =>
          message.id === messageId
            ? {
                ...message,
                deepState: {
                  status: "failure",
                  text: "The answer above remains the supported view. Run Research deeper again for a new evidence pass.",
                  retryable: true,
                },
              }
            : message
        )
      );
    } finally {
      researchInFlightRef.current.delete(messageId);
      researchAbortRef.current.delete(messageId);
    }
  };

  return (
    <FloatingWidgetView
      isExpanded={isExpanded}
      isClosing={isClosing}
      handleOpen={handleOpen}
      handleClose={handleClose}
      handleExitComplete={() => setIsClosing(false)}
      dialogRef={dialogRef}
      messages={messages}
      runResearch={runResearch}
      retryMessage={retryMessage}
      submitClarification={submitClarification}
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
