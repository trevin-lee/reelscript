/**
 * Page clock shim, injected before any page script runs.
 *
 * Replaces the page's notion of time (timers, requestAnimationFrame, Date,
 * performance.now) with a virtual clock that only moves when the renderer
 * calls `window.__reelscript_advance(ms)`, and steps CSS transitions /
 * animations by the same amount through the Web Animations API. Chromium's
 * own compositor keeps running on real time, so screenshots and input
 * dispatch never stall — only the *content's* clock is deterministic.
 */
export const CLOCK_SHIM = String.raw`
(() => {
  if (window.__reelscript_advance) return;
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const rafs = new Map();
  const tracked = new WeakMap(); // Animation -> virtual currentTime
  const epoch = Date.now();
  const RealDate = Date;

  const g = window;
  g.setTimeout = (fn, delay = 0, ...args) => {
    const id = nextId++;
    timers.set(id, { at: now + Math.max(0, Number(delay) || 0), fn, args, every: 0 });
    return id;
  };
  g.setInterval = (fn, delay = 0, ...args) => {
    const id = nextId++;
    const every = Math.max(1, Number(delay) || 0);
    timers.set(id, { at: now + every, fn, args, every });
    return id;
  };
  g.clearTimeout = g.clearInterval = (id) => { timers.delete(id); };
  g.requestAnimationFrame = (fn) => { const id = nextId++; rafs.set(id, fn); return id; };
  g.cancelAnimationFrame = (id) => { rafs.delete(id); };
  g.requestIdleCallback = (fn) => g.setTimeout(() => fn({ didTimeout: false, timeRemaining: () => 8 }), 1);
  g.cancelIdleCallback = g.clearTimeout;
  Performance.prototype.now = () => now;
  class VDate extends RealDate {
    constructor(...a) { a.length === 0 ? super(epoch + now) : super(...a); }
    static now() { return epoch + now; }
  }
  g.Date = VDate;

  const call = (fn, args) => { try { typeof fn === "function" ? fn(...args) : new Function(String(fn))(); } catch (e) { console.error(e); } };

  g.__reelscript_advance = (ms) => {
    const target = now + ms;
    // Fire timers in chronological order, including ones scheduled while firing.
    for (let guard = 0; guard < 10000; guard++) {
      let pick = null;
      for (const [id, t] of timers) if (t.at <= target && (!pick || t.at < pick[1].at)) pick = [id, t];
      if (!pick) break;
      const [id, t] = pick;
      now = t.at;
      if (t.every) t.at += t.every; else timers.delete(id);
      call(t.fn, t.args);
    }
    now = target;
    // One animation frame per rendered frame.
    const cbs = Array.from(rafs.values());
    rafs.clear();
    for (const cb of cbs) call(cb, [now]);
    // Step every running CSS transition / animation by exactly ms.
    for (const a of document.getAnimations()) {
      let ct = tracked.get(a);
      if (ct === undefined) {
        // New since last frame: restart it on this frame boundary.
        a.pause();
        ct = 0;
      } else {
        ct += ms;
      }
      const timing = a.effect && a.effect.getComputedTiming();
      const end = timing ? timing.endTime : Infinity;
      if (ct >= end) {
        tracked.delete(a);
        a.playbackRate = 1;
        a.finish();
      } else {
        a.currentTime = ct;
        tracked.set(a, ct);
      }
    }
  };
})();
`;
