import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import styles from '@/styles/FloatingWidget.module.css';
import { getSummary, warmStockSage } from '@/app/actions';

type Message = {
  id: number;
  sender: 'ai' | 'user';
  text: string;
};

const initialMessages: Message[] = [
  {
    id: 1,
    sender: 'ai',
    text: 'Welcome to StockSage. Ask me about any stock trend or its news sentiment. How can I help you today?',
  },
];

interface FloatingWidgetProps {
  isExpanded?: boolean;
  onClose?: () => void;
  onOpen?: () => void;
}

export function FloatingWidget({ isExpanded: propIsExpanded, onClose, onOpen }: FloatingWidgetProps) {
  const [isExpandedInternal, setIsExpandedInternal] = useState(false);

  // Use either prop-controlled or internal state
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
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Stable id for this chat session so the Langflow RAG flow can keep memory
  // across turns. Generated once per mounted widget.
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

  // Nudge the hosted AI Space awake on mount so it's warm by the time the user
  // sends their first message (avoids the cold-start delay).
  useEffect(() => {
    warmStockSage();
  }, []);

  const sendMessage = async () => {
    const text = inputValue.trim();
    if (!text || isThinking) return;

    setInputValue('');
    setMessages((prev) => [
      ...prev,
      { id: prev.length + 1, sender: 'user', text },
    ]);
    setIsThinking(true);

    try {
      // Pass the turns so far (excludes the canned welcome) so the flow has
      // conversational memory for follow-up questions.
      const history = messages
        .filter((m) => m.id !== 1)
        .map((m) => ({ role: m.sender, text: m.text }));
      const reply = await getSummary(
        text,
        sessionIdRef.current ?? undefined,
        history
      );
      setMessages((prev) => [
        ...prev,
        { id: prev.length + 1, sender: 'ai', text: reply.text },
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
            className="bg-card text-card-foreground border border-border rounded-lg shadow-lg p-4 w-[200px] hover:shadow-xl transition-shadow cursor-pointer"
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

                  {/* chat history with left scrollbar */}
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
                              <div className="text-sm leading-relaxed space-y-2 [&_strong]:font-semibold [&_em]:italic [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_a]:underline [&_a]:text-blue-600 dark:[&_a]:text-blue-400">
                                <ReactMarkdown>{msg.text}</ReactMarkdown>
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
                            Thinking...
                          </div>
                        </div>
                      )}
                      <div ref={chatEndRef} />
                    </div>
                  </div>

                  <div className="mt-auto flex gap-4">
                    <div className="flex text-sm text-muted-foreground p-4 bg-muted rounded-lg outline outline-1 outline-border w-full">
                      <form className="w-full" onSubmit={handleSubmit}>
                        <input 
                          type="text" 
                          value={inputValue}
                          onChange={(e) => setInputValue(e.target.value)}
                          placeholder="Ask me about any stock or market trend" 
                          className="w-full outline-none bg-transparent" 
                        />
                      </form>
                    </div>
                    <img 
                      src="/chatSendButton.svg" 
                      alt="SendChat" 
                      onClick={sendMessage}
                      className="w-10 h-full cursor-pointer dark:invert" 
                    />
                  </div>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
