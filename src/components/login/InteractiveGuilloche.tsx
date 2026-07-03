"use client"

import { useEffect, useRef, useState } from "react"
import { Guilloche } from "./Guilloche"

export function InteractiveGuilloche({ className }: { className?: string }) {
  const stageRef = useRef<HTMLDivElement>(null)
  const [drawKey, setDrawKey] = useState(0)

  useEffect(() => {
    const root = document.documentElement
    let wasDark = root.classList.contains("dark")
    const observer = new MutationObserver(() => {
      const isDark = root.classList.contains("dark")
      if (isDark !== wasDark) {
        wasDark = isDark
        setDrawKey((k) => k + 1)
      }
    })
    observer.observe(root, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [])

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
        <Guilloche
          key={drawKey}
          className="guilloche-depth-2 h-full w-full text-[color:var(--guilloche-ink)]"
        />
      </div>
    </div>
  )
}
