"use client";

import type { HTMLAttributes, ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

const DEFAULT_FRAME_CLASSNAME =
  "relative w-full max-w-lg rounded-2xl border border-white/50 dark:border-white/10 bg-white/80 dark:bg-card/85 backdrop-blur-xl shadow-2xl p-8 animate-in zoom-in-95 duration-200";

interface ModalFrameProps {
  onClose: () => void;
  children: ReactNode;
  frameClassName?: string;
  frameProps?: Omit<HTMLAttributes<HTMLDivElement>, "className" | "onClick">;
}

// Renders through a portal on <body> so the overlay always covers the
// viewport. Otherwise `position: fixed` is captured by the nearest ancestor
// with a `backdrop-filter` (our dark-mode `.glass-card` panels), which would
// trap the modal inside that panel instead of centering it on screen.
export function ModalFrame({
  onClose,
  children,
  frameClassName = DEFAULT_FRAME_CLASSNAME,
  frameProps,
}: ModalFrameProps) {
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/30 backdrop-blur-xl animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        {...frameProps}
        className={frameClassName}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-4 right-4 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          <X className="h-5 w-5" />
        </button>
        {children}
      </div>
    </div>,
    document.body
  );
}
