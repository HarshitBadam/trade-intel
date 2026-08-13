"use client";

import { useState } from "react";
import { ModalFrame } from "@/components/shared/ModalFrame";
import { useModalDismiss } from "@/hooks/useModalDismiss";

const SECTIONS = [
  {
    h: "Not financial advice",
    p: "TradeIntel is an informational tool. Nothing here is financial or investment advice. You stay responsible for your own decisions.",
  },
  {
    h: "About StockSage",
    p: "StockSage writes answers from public news sources. It can be wrong or incomplete. It does not guarantee accuracy and is not liable for any decision you make from its output.",
  },
  {
    h: "Your privacy",
    p: "TradeIntel uses Google to handle sign in and only accesses your name and email address. This information is used solely to operate your account and is never sold to third parties.",
  },
  {
    h: "No liability",
    p: "TradeIntel and its authors are not accountable for any loss or outcome that comes from using this site.",
  },
];

export function LegalDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const mounted = useModalDismiss(open, onClose);

  if (!open || !mounted) return null;

  return (
    <ModalFrame onClose={onClose}>
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
    </ModalFrame>
  );
}

export function LegalModal() {
  const [open, setOpen] = useState(false);

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

      <LegalDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
