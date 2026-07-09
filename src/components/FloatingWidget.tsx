import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import styles from '@/styles/FloatingWidget.module.css';

export const messages = [
  { id: 1, sender: "ai", text: "Welcome! I can provide stock trends, sentiment analysis, and market updates. How can I assist you with the stock market today?" },
  { id: 2, sender: "user", text: "What's the latest on Tesla (TSLA)?" },
  { id: 3, sender: "ai", text: "Tesla (TSLA) is currently trading at $950.30, up 2.4% today. The sentiment is 65% bullish based on recent news and social media trends." },
  { id: 4, sender: "user", text: "Why is the sentiment bullish?" },
  { id: 5, sender: "ai", text: "Tesla recently announced record quarterly deliveries, and analysts are optimistic about its EV expansion. Positive media coverage has driven investor confidence." },
  { id: 6, sender: "user", text: "Is Apple (AAPL) trending too?" },
  { id: 7, sender: "ai", text: "Yes! Apple (AAPL) has a 72% positive sentiment today. The stock is up 1.8% after reports of strong iPhone sales and new AI features coming to iOS." },
  { id: 8, sender: "user", text: "Great! Thanks for the update." },
  { id: 9, sender: "ai", text: "You're welcome! Let me know if you need any more insights." }
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
      // If we're in controlled mode, call the parent's handler
      onOpen();
    } else {
      // If we're in uncontrolled mode, use internal state
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

  const [inputValue, setInputValue] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Handle the message submission here
    if (inputValue.trim()) {
      // Add your message handling logic here
      setInputValue('');
    }
  };

  const handleSendClick = () => {
    if (inputValue.trim()) {
      // Add your message handling logic here
      setInputValue('');
    }
  };

  return (
    <>
      {!isExpanded && (
        <div className="fixed bottom-6 right-6 pointer-events-auto z-10">
          <div
            onClick={handleOpen}
            className="bg-white rounded-lg shadow-lg p-4 w-[200px] hover:shadow-xl transition-shadow cursor-pointer"
          >
            <h3 className="font-semibold mb-2">StockSage</h3>
            <div className="text-sm text-gray-600">Get Stock Insights</div>
          </div>
        </div>
      )}

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 z-50"
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
              className="bg-white rounded-xl overflow-y-auto origin-bottom-right shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="p-6 h-full flex flex-col">
                <div className="max-w-7xl mx-auto w-full flex flex-col h-full">
                  <div className="flex justify-between items-center mb-4">
                    <h2 className="text-xl font-bold">StockSage</h2>
                    <button
                      onClick={handleClose}
                      className="p-2 hover:bg-gray-100 rounded-full"
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
                            className={`p-3 rounded-lg max-w-xs ${
                              msg.sender === "user" ? "bg-gray-50 text-black" : "text-black"
                            }`}
                          >
                            {msg.text}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="mt-auto flex gap-4">
                    <div className="flex text-sm text-gray-500 p-4 bg-gray-50 rounded-lg outline outline-1 outline-gray-200 w-full">
                      <form className="w-full" onSubmit={handleSubmit}>
                        <input 
                          type="text" 
                          value={inputValue}
                          onChange={(e) => setInputValue(e.target.value)}
                          placeholder="Ask me about any stock or market trend..." 
                          className="w-full outline-none bg-transparent" 
                        />
                      </form>
                    </div>
                    <img 
                      src="/chatSendButton.svg" 
                      alt="SendChat" 
                      onClick={handleSendClick}
                      className="w-10 h-full cursor-pointer" 
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