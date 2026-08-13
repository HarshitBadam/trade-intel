import "server-only";

// Minimal sliding-window pacer. Alpaca (~200/min) and Finnhub (~60/min) have
// generous limits and every fetcher sits behind `unstable_cache`, so real
// request volume is low. This gate smooths accidental bursts (e.g. a cold
// render fanning out), it paces to the configured budget and otherwise stays
// out of the way. It never rejects; callers await their turn.
export function slidingLimiter(
  budget: number,
  windowMs: number
): () => Promise<void> {
  const stamps: number[] = [];
  const waiters: Array<() => void> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const prune = (now: number) => {
    while (stamps.length > 0 && stamps[0] <= now - windowMs) stamps.shift();
  };

  const pump = () => {
    // Expire old slots, release queued callers, then wake when the oldest
    // remaining slot leaves the window.
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

    const wakeAt = stamps[0] + windowMs;
    timer = setTimeout(pump, Math.max(25, wakeAt - Date.now()));
    // Don't hold the process open for the scheduler alone.
    timer.unref?.();
  };

  return function acquire(): Promise<void> {
    const now = Date.now();
    prune(now);
    if (waiters.length === 0 && stamps.length < budget) {
      stamps.push(now);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiters.push(resolve);
      pump();
    });
  };
}
