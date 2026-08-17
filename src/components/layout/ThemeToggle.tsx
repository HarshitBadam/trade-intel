"use client";

import { useEffect, useState } from "react";

const THEME_TRANSITION_MS = 420;
let fallbackTimer: number | undefined;

type ThemeViewTransition = {
  finished: Promise<unknown>;
};

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => ThemeViewTransition;
};

function transitionToTheme(nextDark: boolean, afterChange: () => void) {
  const root = document.documentElement;
  const update = () => {
    root.classList.toggle("dark", nextDark);
    afterChange();
  };

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    update();
    return;
  }

  const transitionDocument = document as ViewTransitionDocument;
  if (transitionDocument.startViewTransition) {
    root.classList.add("theme-view-transitioning");
    void root.offsetWidth;
    try {
      const transition = transitionDocument.startViewTransition(update);
      const clearTransitionState = () =>
        root.classList.remove("theme-view-transitioning");
      void transition.finished.then(clearTransitionState, clearTransitionState);
      return;
    } catch {
      root.classList.remove("theme-view-transitioning");
    }
  }

  window.clearTimeout(fallbackTimer);
  root.classList.add("theme-fallback-transition");
  void root.offsetWidth;
  update();
  fallbackTimer = window.setTimeout(() => {
    root.classList.remove("theme-fallback-transition");
  }, THEME_TRANSITION_MS);
}

export function ThemeToggle() {
  const [isDark, setIsDark] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    setIsDark(root.classList.contains("dark"));
    setMounted(true);
    // Enable the icon transition after the initial theme has painted.
    const id = requestAnimationFrame(() => setReady(true));

    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemChange = (e: MediaQueryListEvent) => {
      try {
        if (localStorage.getItem("theme")) return;
      } catch {}
      transitionToTheme(e.matches, () => setIsDark(e.matches));
    };
    mql.addEventListener("change", onSystemChange);

    return () => {
      cancelAnimationFrame(id);
      window.clearTimeout(fallbackTimer);
      root.classList.remove("theme-view-transitioning");
      root.classList.remove("theme-fallback-transition");
      mql.removeEventListener("change", onSystemChange);
    };
  }, []);

  const toggle = () => {
    const root = document.documentElement;
    const next = !root.classList.contains("dark");
    transitionToTheme(next, () => {
      try {
        localStorage.setItem("theme", next ? "dark" : "light");
      } catch {}
      setIsDark(next);
    });
  };

  return (
    <button
      type="button"
      onClick={toggle}
      role="switch"
      aria-checked={mounted ? isDark : undefined}
      aria-label="Toggle dark mode"
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      data-dark={mounted ? isDark : undefined}
      suppressHydrationWarning
      className={`theme-toggle group relative inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors duration-200 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 active:scale-90 cursor-pointer ${
        ready ? "tt-ready" : ""
      }`}
    >
      <svg
        className="tt-svg"
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <mask id="theme-toggle-moon">
          <rect width="24" height="24" fill="white" />
          <circle className="tt-bite" cx="24" cy="9.9" r="4" fill="black" />
        </mask>

        <circle
          className="tt-disk"
          cx="12"
          cy="12"
          r="4"
          fill="currentColor"
          mask="url(#theme-toggle-moon)"
        />

        <g
          className="tt-rays"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <line x1="12" y1="2.5" x2="12" y2="6.2" />
          <line x1="12" y1="17.8" x2="12" y2="21.5" />
          <line x1="2.5" y1="12" x2="6.2" y2="12" />
          <line x1="17.8" y1="12" x2="21.5" y2="12" />
          <line x1="5.28" y1="5.28" x2="7.9" y2="7.9" />
          <line x1="16.1" y1="16.1" x2="18.72" y2="18.72" />
          <line x1="16.1" y1="7.9" x2="18.72" y2="5.28" />
          <line x1="5.28" y1="18.72" x2="7.9" y2="16.1" />
        </g>
      </svg>
    </button>
  );
}
