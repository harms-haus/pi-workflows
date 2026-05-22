import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TimerManager } from "../TimerManager";

describe("TimerManager", () => {
  let tm: TimerManager;

  beforeEach(() => {
    vi.useFakeTimers();
    tm = new TimerManager();
  });

  afterEach(() => {
    tm.clearAll();
    vi.useRealTimers();
  });

  // ── startInterval ──

  describe("startInterval", () => {
    it("creates a tracked interval that fires", () => {
      const callback = vi.fn();
      tm.startInterval(100, callback);

      // Should not fire immediately
      expect(callback).not.toHaveBeenCalled();

      // Should fire after delay
      vi.advanceTimersByTime(100);
      expect(callback).toHaveBeenCalledTimes(1);

      // Should fire again on the next tick
      vi.advanceTimersByTime(100);
      expect(callback).toHaveBeenCalledTimes(2);
    });
  });

  // ── startTimeout ──

  describe("startTimeout", () => {
    it("creates a tracked timeout that fires", () => {
      const callback = vi.fn();
      tm.startTimeout(500, callback);

      // Should not fire immediately
      expect(callback).not.toHaveBeenCalled();

      // Should fire after delay
      vi.advanceTimersByTime(500);
      expect(callback).toHaveBeenCalledTimes(1);

      // Should not fire again (setTimeout is one-shot)
      vi.advanceTimersByTime(500);
      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  // ── clearAll ──

  describe("clearAll", () => {
    it("clears both interval and timeout — callbacks don't fire after clear", () => {
      const intervalCb = vi.fn();
      const timeoutCb = vi.fn();

      tm.startInterval(100, intervalCb);
      tm.startTimeout(200, timeoutCb);

      // Clear before either fires
      tm.clearAll();

      vi.advanceTimersByTime(500);

      expect(intervalCb).not.toHaveBeenCalled();
      expect(timeoutCb).not.toHaveBeenCalled();
    });

    it("is safe to call when no timers are active", () => {
      expect(() => {
        tm.clearAll();
      }).not.toThrow();
    });

    it("is safe to call multiple times in a row", () => {
      tm.startInterval(100, vi.fn());
      expect(() => {
        tm.clearAll();
        tm.clearAll();
        tm.clearAll();
      }).not.toThrow();
    });
  });

  // ── Stale callback prevention ──

  describe("stale callback prevention", () => {
    it("clearAll before timeout fires prevents callback", () => {
      const callback = vi.fn();
      tm.startTimeout(200, callback);

      tm.clearAll();

      vi.advanceTimersByTime(500);
      expect(callback).not.toHaveBeenCalled();
    });

    it("clearAll before interval fires prevents callback", () => {
      const callback = vi.fn();
      tm.startInterval(100, callback);

      tm.clearAll();

      vi.advanceTimersByTime(500);
      expect(callback).not.toHaveBeenCalled();
    });
  });

  // ── Replacing timers ──

  describe("replacing timers", () => {
    it("calling startInterval again replaces the previous one (old callback doesn't fire)", () => {
      const oldCallback = vi.fn();
      const newCallback = vi.fn();

      tm.startInterval(100, oldCallback);
      tm.startInterval(100, newCallback);

      vi.advanceTimersByTime(100);

      // Only the new callback should fire
      expect(oldCallback).not.toHaveBeenCalled();
      expect(newCallback).toHaveBeenCalledTimes(1);
    });

    it("calling startTimeout again replaces the previous one (old callback doesn't fire)", () => {
      const oldCallback = vi.fn();
      const newCallback = vi.fn();

      tm.startTimeout(100, oldCallback);
      tm.startTimeout(100, newCallback);

      vi.advanceTimersByTime(100);

      // Only the new callback should fire
      expect(oldCallback).not.toHaveBeenCalled();
      expect(newCallback).toHaveBeenCalledTimes(1);
    });

    it("interval and timeout are independent — replacing one doesn't affect the other", () => {
      const intervalCb = vi.fn();
      const timeoutCb = vi.fn();

      tm.startInterval(100, intervalCb);
      tm.startTimeout(200, timeoutCb);

      // Replace only the interval
      const newIntervalCb = vi.fn();
      tm.startInterval(100, newIntervalCb);

      vi.advanceTimersByTime(200);

      // Old interval should NOT fire, new interval should fire twice
      expect(intervalCb).not.toHaveBeenCalled();
      expect(newIntervalCb).toHaveBeenCalledTimes(2);

      // Timeout should still fire normally
      expect(timeoutCb).toHaveBeenCalledTimes(1);
    });
  });
});
