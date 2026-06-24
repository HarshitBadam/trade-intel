"use client"

import { useEffect, useRef } from "react"
import { Guilloche } from "./Guilloche"

// Wraps the server-rendered engraving and makes it drift/tilt toward the
// pointer. We only write two CSS custom properties (--gx/--gy, smoothed in a
// rAF loop) and let CSS do the transforms, so there is no React re-render per
// frame. Honors reduced motion and cleans up its listener on unmount.
export function InteractiveGuilloche({ className }: { className?: string }) {
  const stageRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return

    let targetX = 0
    let targetY = 0
    let currentX = 0
    let currentY = 0
    let raf = 0

    const tick = () => {
      currentX += (targetX - currentX) * 0.07
      currentY += (targetY - currentY) * 0.07
      stage.style.setProperty("--gx", currentX.toFixed(4))
      stage.style.setProperty("--gy", currentY.toFixed(4))
      if (Math.abs(targetX - currentX) > 0.0005 || Math.abs(targetY - currentY) > 0.0005) {
        raf = requestAnimationFrame(tick)
      } else {
        raf = 0
      }
    }

    const onMove = (e: PointerEvent) => {
      targetX = (e.clientX / window.innerWidth) * 2 - 1
      targetY = (e.clientY / window.innerHeight) * 2 - 1
      if (!raf) raf = requestAnimationFrame(tick)
    }

    window.addEventListener("pointermove", onMove, { passive: true })
    return () => {
      window.removeEventListener("pointermove", onMove)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  return (
    <div ref={stageRef} className={className} aria-hidden="true">
      <div className="guilloche-depth-1 h-full w-full">
        <Guilloche className="guilloche-depth-2 h-full w-full text-[color:var(--guilloche-ink)]" />
      </div>
    </div>
  )
}
