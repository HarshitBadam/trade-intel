"use client";

import { useEffect, useState } from "react";

let bodyScrollLocks = 0;
let previousBodyOverflow = "";

function lockBodyScroll(): () => void {
  if (bodyScrollLocks === 0) {
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  bodyScrollLocks += 1;

  return () => {
    bodyScrollLocks = Math.max(0, bodyScrollLocks - 1);
    if (bodyScrollLocks === 0) {
      document.body.style.overflow = previousBodyOverflow;
    }
  };
}

/**
 * Shared modal lifecycle: gates the portal on client mount so SSR and the
 * first hydration pass render nothing (modals are always opened by a
 * post-mount user interaction anyway), closes on Escape, and locks page
 * scroll while open.
 */
export function useModalDismiss(open: boolean, onClose: () => void): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const unlockBodyScroll = lockBodyScroll();
    return () => {
      document.removeEventListener("keydown", onKey);
      unlockBodyScroll();
    };
  }, [open, onClose]);

  return mounted;
}
