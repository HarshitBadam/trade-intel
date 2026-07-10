import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, ArrowUp, Telescope } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import styles from './FloatingWidget.module.css';
import { getSummary } from '@/app/actions';
import { LegalDialog } from '@/components/legal/LegalModal';
import type { ChatMode } from '@/lib/stocksage/types';

type Message = {
  id: number;
  sender: 'ai' | 'user';
  text: string;
  citationUrls?: string[];
};

const initialMessages: Message[] = [
  {
    id: 1,
    sender: 'ai',
    text: "Welcome to StockSage, your AI markets assistant. Ask me about any stock's trend or its news sentiment.",
  },
];

function CitationChip({
  href,
  children,
  allowedHrefs,
}: {
  href?: string;
  children?: React.ReactNode;
  allowedHrefs?: string[];
}) {
  let domain = '';
  let safeHref = '';
  try {
    if (href) {
      const url = new URL(href);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        safeHref = url.toString();
        domain = url.hostname.replace(/^www\./, '');
      }
    }
  } catch {
  }
  const allowed = (allowedHrefs ?? []).some((candidate) => {
    try {
      return new URL(candidate).toString() === safeHref;
    } catch {
      return false;
    }
  });
  if (!safeHref || !allowed) return <span>{children}</span>;
  const favicon = domain
    ? `https://www.google.com/s2/favicons?domain=${domain}&sz=64`
    : '';
  return (
    <a
      href={safeHref}
      target="_blank"
      rel="noopener noreferrer"
      title={domain || undefined}
      className="mx-0.5 inline-flex items-center gap-1 align-middle whitespace-nowrap rounded-md bg-muted/70 px-1.5 py-px text-[0.78em] font-medium leading-none text-foreground/70 no-underline transition-colors hover:bg-accent hover:text-foreground"
    >
      {favicon && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={favicon}
          alt=""
          aria-hidden
          className="h-[1.05em] w-[1.05em] rounded-[3px]"
          onError={(e) => {
            e.currentTarget.style.display = 'none';
          }}
        />
      )}
      <span>{children}</span>
    </a>
  );
}

function tidyCitations(text: string): string {
  const LINK = '\\[[^\\]]+\\]\\((?:[^()]|\\([^()]*\\))*\\)';
  const wrapped = new RegExp(`\\(\\s*(${LINK})\\s*(?:,[^()]*?)?\\)`, 'g');
  const trailingDate = new RegExp(`(${LINK})\\s*\\(\\s*\\d[\\d\\-/.\\s]*\\)`, 'g');
  return text
    .replace(wrapped, '$1')
    .replace(trailingDate, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,;:])/g, '$1');
}

interface FloatingWidgetProps {
  isExpanded?: boolean;
  onClose?: () => void;
  onOpen?: () => void;
}

export function FloatingWidget({ isExpanded: propIsExpanded, onClose, onOpen }: FloatingWidgetProps) {
  const [isExpandedInternal, setIsExpandedInternal] = useState(false);

  const isExpanded = propIsExpanded ?? isExpandedInternal;

  const handleOpen = () => {
    if (onOpen) {
      onOpen();
    } else {
      setIsExpandedInternal(true);
    }
  };

  const handleClose = () => {
    if (onClose) {
      onClose();
    }
    setIsExpandedInternal(false);
  };

  useEffect(() => {
    if (isExpanded) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'unset';
    }
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [isExpanded]);

  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [inputValue, setInputValue] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [selectedMode, setSelectedMode] = useState<ChatMode>('regular');
  const [pendingMode, setPendingMode] = useState<ChatMode | null>(null);
  const [showLegal, setShowLegal] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const sessionIdRef = useRef<string | null>(null);
  if (sessionIdRef.current === null) {
    sessionIdRef.current =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isThinking]);

  const sendMessage = async () => {
    const text = inputValue.trim();
    if (!text || isThinking) return;
    const mode = selectedMode;

    setInputValue('');
    setSelectedMode('regular');
    setMessages((prev) => [
      ...prev,
      { id: prev.length + 1, sender: 'user', text },
    ]);
    setIsThinking(true);
    setPendingMode(mode);

    const history = messages
      .filter((m) => m.id !== 1)
      .map((m) => ({ role: m.sender, text: m.text }));

    try {
      const request = {
        message: text,
        mode,
        sessionId: sessionIdRef.current ?? undefined,
        history,
      };
      const reply = await getSummary(request);

      setMessages((prev) => [
        ...prev,
        {
          id: prev.length + 1,
          sender: 'ai',
          text: reply.text,
          citationUrls: reply.citationUrls,
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: prev.length + 1,
          sender: 'ai',
          text: 'Something went wrong while fetching an answer. Please try again.',
        },
      ]);
    } finally {
      setIsThinking(false);
      setPendingMode(null);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage();
  };

  return (
    <>
      {!isExpanded && (
        <div className="fixed bottom-6 right-6 pointer-events-auto z-10">
          <div
            onClick={handleOpen}
            className="bg-card text-card-foreground border border-border glass-card rounded-lg shadow-lg p-4 w-[200px] hover:shadow-xl transition-shadow cursor-pointer"
          >
            <h3 className="font-semibold mb-2">StockSage</h3>
            <div className="text-sm text-muted-foreground">Get Stock Insights</div>
          </div>
        </div>
      )}

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/30 backdrop-blur-xl z-50"
            onClick={handleClose}
          >
            <motion.div
              initial={{ 
                width: "200px",
                height: "76px",
                position: "absolute",
                bottom: "24px",
                right: "24px",
                opacity: 1
              }}
              animate={{ 
                width: "calc(100% - 64px)",
                height: "calc(100% - 64px)",
                position: "absolute",
                bottom: "32px",
                right: "32px",
                opacity: 1
              }}
              exit={{ 
                width: "200px",
                height: "76px",
                position: "absolute",
                bottom: "24px",
                right: "24px",
                opacity: 1
              }}
              transition={{ type: "spring", damping: 25, stiffness: 120 }}
              className="bg-white/80 dark:bg-card/85 backdrop-blur-xl border border-white/50 dark:border-white/10 rounded-xl overflow-y-auto origin-bottom-right shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="p-6 h-full flex flex-col">
                <div className="max-w-7xl mx-auto w-full flex flex-col h-full">
                  <div className="flex justify-between items-center mb-4">
                    <h2 className="text-xl font-bold">StockSage</h2>
                    <button
                      onClick={handleClose}
                      className="p-2 hover:bg-muted rounded-full transition-colors"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>

                  <div className={`flex-1 overflow-y-scroll`}>
                    <div className={styles.chatContent}>
                      {messages.map((msg) => (
                        <div
                          key={msg.id}
                          className={`flex max-w-full ${msg.sender === "user" ? "justify-end" : "justify-start"}`}
                        >
                          <div
                            className={`p-3 rounded-lg max-w-xs text-foreground ${
                              msg.sender === "user" ? "bg-muted" : ""
                            }`}
                          >
                            {msg.sender === "ai" ? (
                              <div className="text-sm leading-relaxed space-y-2 [&_strong]:font-semibold [&_em]:italic [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4">
                                <ReactMarkdown
                                  components={{
                                    a: ({ href, children }) => (
                                      <CitationChip
                                        href={href}
                                        allowedHrefs={msg.citationUrls}
                                      >
                                        {children}
                                      </CitationChip>
                                    ),
                                  }}
                                >
                                  {tidyCitations(msg.text)}
                                </ReactMarkdown>
                              </div>
                            ) : (
                              msg.text
                            )}
                          </div>
                        </div>
                      ))}
                      {isThinking && (
                        <div className="flex max-w-full justify-start">
                          <div className="p-3 rounded-lg max-w-xs text-muted-foreground animate-pulse">
                            {pendingMode === "deep"
                              ? "Running Deep Research…"
                              : "Thinking…"}
                          </div>
                        </div>
                      )}
                      <div ref={chatEndRef} />
                    </div>
                  </div>

                  <div className="mt-auto flex gap-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground p-2 bg-muted rounded-lg outline outline-1 outline-border w-full">
                      <button
                        type="button"
                        onClick={() =>
                          setSelectedMode((mode) =>
                            mode === "deep" ? "regular" : "deep"
                          )
                        }
                        disabled={isThinking}
                        aria-pressed={selectedMode === "deep"}
                        aria-label="Toggle Deep Research"
                        title="Use the Langflow Deep Research workflow for this message"
                        className={`flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors ${
                          selectedMode === "deep"
                            ? "bg-foreground text-background"
                            : "bg-background/70 text-foreground/70 hover:text-foreground"
                        }`}
                      >
                        <Telescope className="h-4 w-4" />
                        <span className="hidden sm:inline">Deep Research</span>
                      </button>
                      <form className="w-full px-2" onSubmit={handleSubmit}>
                        <input 
                          type="text" 
                          value={inputValue}
                          onChange={(e) => setInputValue(e.target.value)}
                          maxLength={1200}
                          placeholder={
                            selectedMode === "deep"
                              ? "Ask a deeper finance research question"
                              : "Ask about a stock, company, or market"
                          }
                          className="w-full outline-none bg-transparent" 
                        />
                      </form>
                    </div>
                    <button
                      type="button"
                      onClick={sendMessage}
                      disabled={isThinking || !inputValue.trim()}
                      aria-label="Send message"
                      className="flex h-12 w-12 shrink-0 self-center items-center justify-center rounded-full bg-foreground text-background shadow-sm transition-all duration-150 hover:opacity-90 active:scale-95 disabled:opacity-40 disabled:pointer-events-none focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    >
                      <ArrowUp className="h-5 w-5" strokeWidth={2.5} />
                    </button>
                  </div>

                  <p className="mt-4 text-center text-xs text-muted-foreground">
                    StockSage is AI and can be wrong or out of date.{" "}
                    <button
                      type="button"
                      onClick={() => setShowLegal(true)}
                      className="font-medium text-foreground/80 underline-offset-4 hover:underline cursor-pointer"
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
