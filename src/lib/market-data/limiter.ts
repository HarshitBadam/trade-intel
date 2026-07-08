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
  // FIFO of callers parked because the window was full when they arrived.
  const waiters: Array<() => void> = [];
  // Only one scheduler timer is ever armed; concurrent waiters share it instead
  // of each racing their own timeout (which is what let bursts slip through).
  let timer: ReturnType<typeof setTimeout> | null = null;

  const prune = (now: number) => {
    while (stamps.length > 0 && stamps[0] <= now - windowMs) stamps.shift();
  };

  // The single scheduler: expire old stamps, hand slots to as many queued
  // waiters as the budget currently allows, then re-arm one timer for the next
  // moment capacity frees up. Re-checking the budget on every wake is what keeps
  // the release bounded no matter how many callers piled up.
  const pump = () => {
    const now = Date.now();
    prune(now);

    while (waiters.length > 0 && stamps.length < budget) {
      stamps.push(Date.now());
      waiters.shift()!();
    }

    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (waiters.length === 0) return;

    // Capacity next frees up when the oldest stamp ages out; floor the delay so
    // a stale `stamps[0]` can't spin the pump.
    const wakeAt = stamps[0] + windowMs;
    timer = setTimeout(pump, Math.max(25, wakeAt - Date.now()));
    // Don't hold the process open for the scheduler alone.
    timer.unref?.();
  };

  return function acquire(): Promise<void> {
    const now = Date.now();
    prune(now);
    // Fast path: room in the window, resolve without queueing.
    if (waiters.length === 0 && stamps.length < budget) {
      stamps.push(now);
      return Promise.resolve();
    }
    // Otherwise park in FIFO order and let the pump serve us in turn.
    return new Promise<void>((resolve) => {
      waiters.push(resolve);
      pump();
    });
  };
}
