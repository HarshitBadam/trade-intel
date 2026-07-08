import "server-only";

// A minimal sliding-window pacer. Unlike the Polygon budget queue (polygon.ts),
// Alpaca (~200/min) and Finnhub (~60/min) have generous limits and every fetcher
// sits behind `unstable_cache`, so real request volume is low. This gate exists
// only to smooth accidental bursts (e.g. a cold render fanning out) — it paces
// to the configured budget and otherwise stays out of the way. It never rejects;
// callers await their turn.
export function slidingLimiter(
  budget: number,
  windowMs: number
): () => Promise<void> {
  const stamps: number[] = [];

  const prune = (now: number) => {
    while (stamps.length > 0 && stamps[0] <= now - windowMs) stamps.shift();
  };

  return function acquire(): Promise<void> {
    const now = Date.now();
    prune(now);
    if (stamps.length < budget) {
      stamps.push(now);
      return Promise.resolve();
    }
    // Window is full: wait until the oldest stamp ages out, then take its slot.
    const waitMs = Math.max(0, stamps[0] + windowMs - now);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        stamps.push(Date.now());
        // Keep the window bounded even under sustained pressure.
        prune(Date.now());
        resolve();
      }, waitMs);
      t.unref?.();
    });
  };
}
