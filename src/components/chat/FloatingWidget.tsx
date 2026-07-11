import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUp, X } from "lucide-react";
import { getSummary, researchDeeper } from "@/app/actions";
import { LegalDialog } from "@/components/legal/LegalModal";
import type { ConversationState } from "@/lib/stocksage/types";
import {
  ChatMessage,
  type ChatMessageModel,
} from "./ChatMessage";
import styles from "./FloatingWidget.module.css";

const initialMessages: ChatMessageModel[] = [
  {
    id: "welcome",
    sender: "ai",
    text: "Welcome to StockSage, your AI markets assistant. Ask me about a public company, market, or finance concept.",
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
  const conversationStateRef = useRef<ConversationState | undefined>(undefined);
  const sessionIdRef = useRef<string>(localId());
  const isExpanded = propIsExpanded ?? isExpandedInternal;

  const handleOpen = () => {
    if (onOpen) onOpen();
    else setIsExpandedInternal(true);
  };

  const handleClose = () => {
    if (onClose) onClose();
    setIsExpandedInternal(false);
  };

  useEffect(() => {
    document.body.style.overflow = isExpanded ? "hidden" : "unset";
    return () => {
      document.body.style.overflow = "unset";
    };
  }, [isExpanded]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isThinking]);

  const sendMessage = async () => {
    const text = inputValue.trim();
    if (!text || isThinking) return;
    const history = messages
      .filter((message) => message.id !== "welcome")
      .map((message) => ({ role: message.sender, text: message.text }));
    setInputValue("");
    setMessages((previous) => [
      ...previous,
      { id: localId(), sender: "user", text },
    ]);
    setIsThinking(true);
    try {
      const reply = await getSummary({
        message: text,
        sessionId: sessionIdRef.current,
        history,
        state: conversationStateRef.current,
      });
      conversationStateRef.current = reply.state;
      setMessages((previous) => [
        ...previous,
        {
          id: reply.responseId ?? localId(),
          sender: "ai",
          text: reply.text,
          citationUrls: reply.citationUrls,
          deepResearch: reply.deepResearch,
          deepState: reply.deepResearch ? { status: "idle" } : undefined,
        },
      ]);
    } catch {
      setMessages((previous) => [
        ...previous,
        {
          id: localId(),
          sender: "ai",
          text: "Something went wrong while fetching an answer. Please try again.",
        },
      ]);
    } finally {
      setIsThinking(false);
    }
  };

  const runResearch = async (messageId: string) => {
    const target = messages.find((message) => message.id === messageId);
    if (!target?.deepResearch || target.deepState?.status === "pending") return;
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
                  text: "Research deeper failed. The regular answer is still available.",
                  retryable: true,
                },
              }
            : message
        )
      );
    }
  };

  return (
    <>
      {!isExpanded && (
        <div className="pointer-events-auto fixed bottom-6 right-6 z-10">
          <div
            onClick={handleOpen}
            className="glass-card w-[200px] cursor-pointer rounded-lg border border-border bg-card p-4 text-card-foreground shadow-lg transition-shadow hover:shadow-xl"
          >
            <h3 className="mb-2 font-semibold">StockSage</h3>
            <div className="text-sm text-muted-foreground">
              Get Stock Insights
            </div>
          </div>
        </div>
      )}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/30 backdrop-blur-xl"
            onClick={handleClose}
          >
            <motion.div
              initial={{
                width: "200px",
                height: "76px",
                position: "absolute",
                bottom: "24px",
                right: "24px",
              }}
              animate={{
                width: "calc(100% - 64px)",
                height: "calc(100% - 64px)",
                position: "absolute",
                bottom: "32px",
                right: "32px",
              }}
              exit={{
                width: "200px",
                height: "76px",
                position: "absolute",
                bottom: "24px",
                right: "24px",
              }}
              transition={{ type: "spring", damping: 25, stiffness: 120 }}
              className="absolute origin-bottom-right overflow-y-auto rounded-xl border border-white/50 bg-white/80 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-card/85"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex h-full flex-col p-6">
                <div className="mx-auto flex h-full w-full max-w-7xl flex-col">
                  <div className="mb-4 flex items-center justify-between">
                    <h2 className="text-xl font-bold">StockSage</h2>
                    <button
                      onClick={handleClose}
                      className="rounded-full p-2 transition-colors hover:bg-muted"
                      aria-label="Close StockSage"
                    >
                      <X className="h-5 w-5" />
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-scroll">
                    <div className={styles.chatContent}>
                      {messages.map((message) => (
                        <ChatMessage
                          key={message.id}
                          message={message}
                          onResearch={runResearch}
                        />
                      ))}
                      {isThinking && (
                        <div className="flex max-w-full justify-start">
                          <div className="max-w-xs animate-pulse rounded-lg p-3 text-muted-foreground">
                            Thinking…
                          </div>
                        </div>
                      )}
                      <div ref={chatEndRef} />
                    </div>
                  </div>
                  <div className="mt-auto flex gap-4">
                    <form
                      className="flex w-full items-center rounded-lg bg-muted p-2 outline outline-1 outline-border"
                      onSubmit={(event) => {
                        event.preventDefault();
                        sendMessage();
                      }}
                    >
                      <input
                        type="text"
                        value={inputValue}
                        onChange={(event) => setInputValue(event.target.value)}
                        maxLength={1200}
                        placeholder="Ask about a company, market, or finance concept"
                        className="w-full bg-transparent px-2 outline-none"
                      />
                    </form>
                    <button
                      type="button"
                      onClick={sendMessage}
                      disabled={isThinking || !inputValue.trim()}
                      aria-label="Send message"
                      className="flex h-12 w-12 shrink-0 items-center justify-center self-center rounded-full bg-foreground text-background shadow-sm transition-all hover:opacity-90 active:scale-95 disabled:pointer-events-none disabled:opacity-40"
                    >
                      <ArrowUp className="h-5 w-5" strokeWidth={2.5} />
                    </button>
                  </div>
                  <p className="mt-4 text-center text-xs text-muted-foreground">
                    StockSage is AI and can be wrong or out of date.{" "}
                    <button
                      type="button"
                      onClick={() => setShowLegal(true)}
                      className="font-medium text-foreground/80 underline-offset-4 hover:underline"
                    >
                      Terms &amp; Privacy
                    </button>
                  </p>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      <LegalDialog open={showLegal} onClose={() => setShowLegal(false)} />
    </>
  );
}
