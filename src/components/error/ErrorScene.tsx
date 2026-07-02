import type { ReactNode } from "react"

// Minimal, product-grade error scene: a big code, a plain-language message,
// and a way out. The cinema lives in the overlays — crawling film static,
// drifting CRT scanlines, a VHS tracking band — and the chromatic tear on
// the code itself. Copy stays plain; no storytelling.
export function ErrorScene({
  code,
  title,
  description,
  footnote,
  children,
}: {
  code: string
  title: string
  description: string
  footnote?: string
  children?: ReactNode
}) {
  return (
    <div className="relative flex min-h-[calc(100svh-3.5rem)] flex-col overflow-hidden">
      <div className="err-static z-20" aria-hidden="true" />
      <div className="err-scanlines z-20" aria-hidden="true" />

      <section className="relative z-10 flex flex-1 items-center justify-center px-6 py-16">
        <div className="flex w-full max-w-[520px] flex-col items-center text-center">
          <p
            className="err-rise font-mono text-[11px] font-semibold uppercase tracking-[0.3em] text-muted-foreground"
            style={{ animationDelay: "0.05s" }}
          >
            Error {code}
          </p>

          <span
            data-text={code}
            aria-hidden="true"
            className="err-glitch err-rise siri-text font-display mt-2 text-[7rem] font-extrabold leading-[0.95] tracking-tight sm:text-[9rem]"
            style={{ animationDelay: "0.12s" }}
          >
            {code}
          </span>

          <h1
            className="err-rise mt-5 text-2xl font-semibold tracking-tight sm:text-3xl"
            style={{ animationDelay: "0.22s" }}
          >
            {title}
          </h1>

          <p
            className="err-rise mt-3 max-w-[38em] text-[15px] leading-relaxed text-muted-foreground"
            style={{ animationDelay: "0.3s" }}
          >
            {description}
          </p>

          {children && (
            <div
              className="err-rise mt-8 flex flex-wrap items-center justify-center gap-3"
              style={{ animationDelay: "0.38s" }}
            >
              {children}
            </div>
          )}

          {footnote && (
            <p
              className="err-rise mt-8 font-mono text-[11px] tracking-[0.08em] text-muted-foreground/60"
              style={{ animationDelay: "0.45s" }}
            >
              {footnote}
            </p>
          )}
        </div>
      </section>
    </div>
  )
}
