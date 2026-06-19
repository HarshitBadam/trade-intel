"use client";
import { useState } from "react";

interface FlipCardProps {
  front: React.ReactNode;
  back: React.ReactNode;
}

export function FlipCard({ front, back }: FlipCardProps) {
  const [isFlipped, setIsFlipped] = useState(false);

  return (
    <div
      className="flip-card relative w-full h-full cursor-pointer"
      onClick={() => setIsFlipped((f) => !f)}
    >
      <div
        className={`flip-inner relative w-full h-full ${
          isFlipped ? "is-flipped" : ""
        }`}
      >
        <div className="flip-face flip-front absolute inset-0">{front}</div>
        <div className="flip-face flip-back absolute inset-0">{back}</div>
      </div>

      <style jsx>{`
        .flip-card {
          perspective: 2000px;
        }
        .flip-inner {
          transition: transform 700ms cubic-bezier(0.4, 0, 0.2, 1);
          transform-style: preserve-3d;
        }
        .flip-inner.is-flipped {
          transform: rotateY(180deg);
        }
        .flip-face {
          -webkit-backface-visibility: hidden;
          backface-visibility: hidden;
        }
        .flip-back {
          transform: rotateY(180deg);
        }
        /* Root cause of the dark-mode flip glitch: a backdrop-filter on a face's
           content breaks WebKit/Safari's 3D backface culling, so the hidden
           (price) face isn't culled and — because the popularity face is
           translucent — the price chart bleeds through, then "pops" when the
           layer re-composites at the end of the flip. Light mode never applies
           the filter (the .glass-card is a no-op there), which is exactly why
           it flips perfectly. So we drop ONLY the blur on the flip faces; the
           translucent glass tint and the aurora glowing through are preserved. */
        .flip-face :global(.glass-card) {
          -webkit-backdrop-filter: none !important;
          backdrop-filter: none !important;
        }
      `}</style>
    </div>
  );
}
