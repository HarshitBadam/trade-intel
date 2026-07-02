import type { ReactNode } from "react"
import { InteractiveGuilloche } from "@/components/login/InteractiveGuilloche"

// Minimal, product-grade error scene: a big code, a plain-language message,
// and a way out. The banknote guilloché from the login page fills the stage
// behind the copy — the code reads like a seal stamped over the engraving —
// while film static and CRT scanlines add texture on top. Copy stays plain;
// no storytelling.
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
      <div className="err-bg" aria-hidden="true" />
      <InteractiveGuilloche className="err-guilloche pointer-events-none absolute left-1/2 top-1/2 z-0 aspect-square w-[min(760px,92vw)] -translate-x-1/2 -translate-y-1/2" />

      {/* Certificate corner serials — kept clear of the engraving in the far
          corners, so the side space reads as security-print margins. */}
      <p
        aria-hidden="true"
        className="pointer-events-none absolute bottom-6 left-8 z-0 hidden select-none font-mono text-[10px] uppercase tracking-[0.28em] text-foreground/25 md:block xl:left-14"
      >
        Ser. MMXXVI &mdash; No. 000{code}
      </p>
      <p
        aria-hidden="true"
        className="pointer-events-none absolute bottom-6 right-8 z-0 hidden select-none font-mono text-[10px] uppercase tracking-[0.28em] text-foreground/25 md:block xl:right-14"
      >
        TradeIntel &mdash; The Intelligence Desk
      </p>

      <div className="err-static z-20" aria-hidden="true" />
      <div className="err-scanlines z-20" aria-hidden="true" />

      <section className="relative z-10 flex flex-1 items-center justify-center px-6 py-16">
        <div className="relative flex w-full max-w-[520px] select-none flex-col items-center text-center">
          <div className="err-halo" aria-hidden="true" />
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
