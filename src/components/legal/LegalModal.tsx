"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

const SECTIONS = [
  {
    h: "Your privacy",
    p: "TradeIntel does not collect or sell your data. Google handles sign in and shares only your name and email.",
  },
  {
    h: "Not financial advice",
    p: "TradeIntel is an informational tool. Nothing here is financial or investment advice. You stay responsible for your own decisions.",
  },
  {
    h: "About StockSage",
    p: "StockSage writes answers from public news sources. It can be wrong or incomplete. It does not guarantee accuracy and is not liable for any decision you make from its output.",
  },
  {
    h: "No liability",
    p: "TradeIntel and its authors are not accountable for any loss or outcome that comes from using this site.",
  },
];

export function LegalModal() {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  const trigger =
    "font-medium text-foreground/80 underline-offset-4 hover:underline cursor-pointer";

  return (
    <>
      <p className="text-center text-xs leading-relaxed text-muted-foreground">
        By continuing you agree to our{" "}
        <button type="button" onClick={() => setOpen(true)} className={trigger}>
          Terms
        </button>{" "}
        and{" "}
        <button type="button" onClick={() => setOpen(true)} className={trigger}>
          Privacy Policy
        </button>
        .
      </p>

      {open &&
        mounted &&
        createPortal(
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4 backdrop-blur-xl duration-200 animate-in fade-in"
            onClick={() => setOpen(false)}
          >
            <div
              className="relative w-full max-w-lg rounded-2xl border border-white/50 bg-white/80 p-8 shadow-2xl backdrop-blur-xl duration-200 animate-in zoom-in-95 dark:border-white/10 dark:bg-card/85"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="absolute right-4 top-4 cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="h-5 w-5" />
              </button>

              <h2 className="mb-5 font-serif text-2xl font-bold leading-snug">
                Terms &amp; Privacy
              </h2>

              <div className="max-h-[55vh] space-y-5 overflow-y-auto pr-1">
                {SECTIONS.map((s) => (
                  <div key={s.h}>
                    <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                      {s.h}
                    </p>
                    <p className="text-sm leading-relaxed text-foreground/80">
                      {s.p}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
