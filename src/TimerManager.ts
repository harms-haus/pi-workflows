/**
 * TimerManager: tracks a single active setInterval and setTimeout.
 *
 * Prevents stale callbacks by verifying the stored handle still matches
 * the one that was set at the time the callback was scheduled.
 */
export class TimerManager {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  /**
   * Start a new interval. Any previously tracked interval is cleared first.
   */
  startInterval(delay: number, callback: () => void): void {
    this.clearInterval();

    const handle = setInterval(() => {
      // Only execute if the handle hasn't been replaced since scheduling
      if (this.intervalHandle === handle) {
        callback();
      }
    }, delay);

    this.intervalHandle = handle;
  }

  /**
   * Start a new timeout. Any previously tracked timeout is cleared first.
   */
  startTimeout(delay: number, callback: () => void): void {
    this.clearTimeout();

    const handle = setTimeout(() => {
      // Only execute if the handle hasn't been replaced since scheduling
      if (this.timeoutHandle === handle) {
        callback();
      }
    }, delay);

    this.timeoutHandle = handle;
  }

  /**
   * Clear all tracked timers and set handles to null.
   */
  clearAll(): void {
    this.clearInterval();
    this.clearTimeout();
  }

  private clearInterval(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  private clearTimeout(): void {
    if (this.timeoutHandle !== null) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }
}

/** Module-level singleton. */
export const timerManager = new TimerManager();
