"use client";

import { useEffect, useState } from "react";

/**
 * A sun ⇄ moon theme toggle, styled to feel native to Apple's UI.
 *
 * The icon is a single SVG that morphs: in light mode it's a sun (disk + 8
 * rays); tapping it retracts the rays and slides a masked "bite" across the disk
 * to carve a crescent moon. The actual theme is applied by toggling the `.dark`
 * class on <html> (read on first paint by the inline script in the layout), and
 * the choice is persisted to localStorage.
 *
 * Animation timing lives in globals.css (`.theme-toggle …`); transitions only
 * switch on once `.tt-ready` is added post-mount, so the icon snaps to the
 * correct shape on load rather than animating in.
 */
export function ThemeToggle() {
  const [isDark, setIsDark] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setIsDark(document.documentElement.classList.contains("dark"));
    setMounted(true);
    // Enable the icon transitions on the next frame so mounting doesn't animate.
    const id = requestAnimationFrame(() => setReady(true));

    // Keep in sync with OS-level changes when the user hasn't chosen explicitly.
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemChange = (e: MediaQueryListEvent) => {
      try {
        if (localStorage.getItem("theme")) return; // user has an explicit choice
      } catch {}
      document.documentElement.classList.toggle("dark", e.matches);
      setIsDark(e.matches);
    };
    mql.addEventListener("change", onSystemChange);

    return () => {
      cancelAnimationFrame(id);
      mql.removeEventListener("change", onSystemChange);
    };
  }, []);

  // Flip `.dark` + persist. The colour cross-fade is handled entirely in CSS by
  // transitioning the @property-typed theme variables on :root, so it's smooth
  // and consistent across engines (incl. Safari) with no JS timing.
  //
  // System-preference UX: if the user's pick matches the OS, we *clear* the
  // saved override so the app keeps auto-following the system (and the
  // matchMedia listener above will track future OS changes). Only a choice that
  // diverges from the OS is persisted as an explicit override.
  const toggle = () => {
    const root = document.documentElement;
    const next = !root.classList.contains("dark");
    root.classList.toggle("dark", next);
    try {
      const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      if (next === systemDark) {
        localStorage.removeItem("theme");
      } else {
        localStorage.setItem("theme", next ? "dark" : "light");
      }
    } catch {}
    setIsDark(next);
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
