import type {
  Dispatch,
  RefObject,
  SetStateAction,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUp, X } from "lucide-react";
import { LegalDialog } from "@/components/legal/LegalModal";
import {
  ChatMessage,
  type ChatMessageModel,
} from "./ChatMessage";
import styles from "./FloatingWidget.module.css";

type FloatingWidgetViewProps = {
  isExpanded: boolean;
  handleOpen: () => void;
  handleClose: () => void;
  dialogRef: RefObject<HTMLDivElement | null>;
  messages: ChatMessageModel[];
  runResearch: (messageId: string) => void;
  retryMessage: (messageId: string) => void;
  isThinking: boolean;
  chatEndRef: RefObject<HTMLDivElement | null>;
  inputRef: RefObject<HTMLInputElement | null>;
  inputValue: string;
  setInputValue: Dispatch<SetStateAction<string>>;
  sendMessage: () => void;
  showLegal: boolean;
  setShowLegal: Dispatch<SetStateAction<boolean>>;
};

export function FloatingWidgetView({
  isExpanded,
  handleOpen,
  handleClose,
  dialogRef,
  messages,
  runResearch,
  retryMessage,
  isThinking,
  chatEndRef,
  inputRef,
  inputValue,
  setInputValue,
  sendMessage,
  showLegal,
  setShowLegal,
}: FloatingWidgetViewProps) {
  return (
    <>
      {!isExpanded && (
        <div className="pointer-events-auto fixed bottom-6 right-6 z-10">
          <button
            type="button"
            onClick={handleOpen}
            className="glass-card w-[200px] rounded-lg border border-border bg-card p-4 text-left text-card-foreground shadow-lg transition-shadow hover:shadow-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-haspopup="dialog"
          >
            <h3 className="mb-2 font-semibold">StockSage</h3>
            <div className="text-sm text-muted-foreground">
              Talk through a market question
            </div>
          </button>
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
              ref={dialogRef}
              initial={{
                width: "200px",
                height: "76px",
                position: "absolute",
                bottom: "24px",
                right: "24px",
              }}
              animate={{
                width: "calc(100% - 24px)",
                height: "calc(100dvh - 24px)",
                position: "absolute",
                bottom: "12px",
                right: "12px",
              }}
              exit={{
                width: "200px",
                height: "76px",
                position: "absolute",
                bottom: "24px",
                right: "24px",
              }}
              transition={{ type: "spring", damping: 25, stiffness: 120 }}
              className="absolute max-w-7xl origin-bottom-right overflow-hidden rounded-xl border border-white/50 bg-white/80 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-card/85"
              onClick={(event) => event.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-labelledby="stocksage-title"
              aria-describedby="stocksage-description"
            >
              <div
                className="flex h-full flex-col p-3 sm:p-6"
                style={{
                  paddingBottom:
                    "max(0.75rem, env(safe-area-inset-bottom))",
                }}
              >
                <div className="mx-auto flex h-full w-full max-w-7xl flex-col">
                  <div className="mb-4 flex items-center justify-between">
                    <div>
                      <h2 id="stocksage-title" className="text-xl font-bold">
                        StockSage
                      </h2>
                      <p
                        id="stocksage-description"
                        className="text-xs text-muted-foreground"
                      >
                        Ask naturally, follow-ups and comparisons are welcome.
                      </p>
                    </div>
                    <button
                      onClick={handleClose}
                      className="rounded-full p-2 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                          onRetry={retryMessage}
                        />
                      ))}
                      {isThinking && (
                        <div
                          className="flex max-w-full justify-start"
                          role="status"
                          aria-live="polite"
                        >
                          <div className="max-w-xs animate-pulse rounded-lg p-3 text-muted-foreground">
                            Working on that.
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
                        ref={inputRef}
                        type="text"
                        value={inputValue}
                        onChange={(event) => setInputValue(event.target.value)}
                        disabled={isThinking}
                        maxLength={1200}
                        placeholder="Ask StockSage about a company, market, or idea"
                        aria-label="Message StockSage"
                        className="w-full bg-transparent px-2 outline-none disabled:cursor-wait disabled:opacity-60"
                      />
                    </form>
                    <button
                      type="button"
                      onClick={sendMessage}
                      disabled={isThinking || !inputValue.trim()}
                      aria-label="Send message"
                      className="flex h-12 w-12 shrink-0 items-center justify-center self-center rounded-full bg-foreground text-background shadow-sm transition-all hover:opacity-90 active:scale-95 disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    >
                      <ArrowUp className="h-5 w-5" strokeWidth={2.5} />
                    </button>
                  </div>
                  <p className="mt-4 text-center text-xs text-muted-foreground">
                    Verify material decisions against cited sources and timestamps.{" "}
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
