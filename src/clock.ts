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
/** The page clock shim, starting the page's Date at `epoch` (ms), or at the real time when null. */
export function clockShim(epoch: number | null): string {
  return CLOCK_SHIM_SOURCE.replace("__EPOCH__", epoch === null ? "Date.now()" : String(epoch));
}

/**
 * For renders without the frame-stepped clock: shift only Date so the page
 * starts at the pinned time; timers and animations run in real time.
 */
export function dateShim(epoch: number): string {
  return String.raw`
(() => {
  const RealDate = Date;
  const offset = ${epoch} - RealDate.now();
  // A function, not a class, so Date() without new still works (it returns a string).
  function VDate(...a) {
    const nowMs = RealDate.now() + offset;
    if (!new.target) return new RealDate(nowMs).toString();
    return Reflect.construct(RealDate, a.length === 0 ? [nowMs] : a, new.target);
  }
  VDate.prototype = RealDate.prototype;
  Object.setPrototypeOf(VDate, RealDate);
  VDate.now = () => RealDate.now() + offset;
  window.Date = VDate;
})();
`;
}

const CLOCK_SHIM_SOURCE = String.raw`
(() => {
  if (window.__reelscript_advance) return;
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const rafs = new Map();
  const tracked = new WeakMap(); // Animation -> virtual currentTime
  // Animations that ran to their end. One with a fill mode stays in
  // document.getAnimations() after it finishes, and must not be taken for
  // a new one and started over on the next frame.
  const finished = new WeakSet();
  const epoch = __EPOCH__;
  const RealDate = Date;

  const g = window;
  const realSetTimeout = window.setTimeout.bind(window);
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
  // A function, not a class, so Date() without new still works (it returns a
  // string), and a page's own subclass of Date still gets its prototype.
  function VDate(...a) {
    if (!new.target) return new RealDate(epoch + now).toString();
    return Reflect.construct(RealDate, a.length === 0 ? [epoch + now] : a, new.target);
  }
  VDate.prototype = RealDate.prototype;
  Object.setPrototypeOf(VDate, RealDate);
  VDate.now = () => epoch + now;
  g.Date = VDate;

  const call = (fn, args) => { try { typeof fn === "function" ? fn(...args) : new Function(String(fn))(); } catch (e) { console.error(e); } };

  // Text caret. Chromium blinks its own caret on real time, so two renders
  // would differ wherever a text field has focus. Its caret is hidden, and
  // this draws one at the same place instead: solid for half a second after
  // each edit, then blinking every half second, on the frame clock.
  let caret = null;
  let caretCss = null;
  let lastEdit = 0;
  const edited = () => { lastEdit = now; };
  document.addEventListener("input", edited, true);
  document.addEventListener("selectionchange", edited, true);
  document.addEventListener("focusin", edited, true);
  const TEXT_TYPES = ["text", "search", "email", "url", "tel", "password", "number", ""];
  const fieldCaret = (el) => {
    const cs = getComputedStyle(el);
    const isInput = el.tagName === "INPUT";
    const mirror = document.createElement("div");
    for (const p of ["direction", "boxSizing", "width", "height", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "borderStyle",
      "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "fontStyle", "fontVariant", "fontWeight", "fontStretch", "fontSize", "lineHeight",
      "fontFamily", "textAlign", "textTransform", "textIndent", "letterSpacing", "wordSpacing", "tabSize"]) mirror.style[p] = cs[p];
    Object.assign(mirror.style, { position: "absolute", visibility: "hidden", top: "0", left: "-99999px", overflow: "hidden",
      whiteSpace: isInput ? "pre" : "pre-wrap", overflowWrap: isInput ? "normal" : "break-word" });
    const value = el.type === "password" ? "•".repeat(el.value.length) : el.value;
    const at = el.selectionEnd ?? value.length;
    mirror.textContent = value.slice(0, at);
    const mark = document.createElement("span");
    mark.textContent = value.slice(at) || ".";
    mirror.appendChild(mark);
    document.documentElement.appendChild(mirror);
    const left = mark.offsetLeft, top = mark.offsetTop;
    mirror.remove();
    const r = el.getBoundingClientRect();
    const bt = parseFloat(cs.borderTopWidth) || 0, bl = parseFloat(cs.borderLeftWidth) || 0;
    const fs = parseFloat(cs.fontSize) || 16;
    const lh = parseFloat(cs.lineHeight) || fs * 1.2;
    let h = Math.min(lh, fs * 1.25);
    let y = r.top + bt + top - el.scrollTop + (lh - h) / 2;
    if (isInput) {
      const inner = r.height - bt - (parseFloat(cs.borderBottomWidth) || 0) - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
      h = Math.min(fs * 1.25, inner > 0 ? inner : h);
      y = r.top + bt + (parseFloat(cs.paddingTop) || 0) + (inner - h) / 2;
    }
    return { x: r.left + bl + left - el.scrollLeft, y, h, color: cs.color };
  };
  const drawCaret = () => {
    if (!document.documentElement) return;
    if (!caretCss) {
      caretCss = document.createElement("style");
      caretCss.textContent = "*, *::before, *::after { caret-color: transparent !important; }";
      document.documentElement.appendChild(caretCss);
    }
    let spot = null;
    const el = document.activeElement;
    const visible = (e) => {
      const r = e.getBoundingClientRect();
      return r.width > 2 && r.height > 2 && getComputedStyle(e).opacity !== "0";
    };
    if (el && document.hasFocus() && visible(el)) {
      if ((el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && TEXT_TYPES.includes(el.type))) && el.selectionStart === el.selectionEnd && !el.readOnly) {
        try { spot = fieldCaret(el); } catch (e) { spot = null; }
      } else if (el.isContentEditable) {
        const sel = getSelection();
        if (sel && sel.rangeCount && sel.isCollapsed) {
          const rr = sel.getRangeAt(0).getBoundingClientRect();
          const cs = getComputedStyle(el);
          const fs = parseFloat(cs.fontSize) || 16;
          if (rr.height > 0) spot = { x: rr.left, y: rr.top, h: rr.height, color: cs.color };
          else { const er = el.getBoundingClientRect(); spot = { x: er.left + (parseFloat(cs.paddingLeft) || 0), y: er.top + (parseFloat(cs.paddingTop) || 0), h: fs * 1.2, color: cs.color }; }
        }
      }
    }
    const on = spot && (now - lastEdit) % 1000 < 500;
    if (!on) { if (caret) caret.style.display = "none"; return; }
    if (!caret || !caret.isConnected) {
      caret = document.createElement("div");
      caret.setAttribute("aria-hidden", "true");
      Object.assign(caret.style, { position: "fixed", width: "1px", pointerEvents: "none", zIndex: "2147483647", margin: "0", padding: "0" });
      document.documentElement.appendChild(caret);
    }
    Object.assign(caret.style, { display: "block", left: Math.round(spot.x) + "px", top: Math.round(spot.y) + "px", height: Math.round(spot.h) + "px", background: spot.color });
  };

  // Media. <video> and <audio> play on Chromium's real clock, and SVG (SMIL)
  // animations on their own; both would differ between renders. Media is
  // held paused and moved to where the page clock says it should be each
  // frame (the renderer waits for the seek), and each SVG's animation
  // timeline is set from the page clock.
  const media = new WeakMap(); // element -> { playing, t }
  const MediaProto = HTMLMediaElement.prototype;
  const realPlay = MediaProto.play;
  const realPause = MediaProto.pause;
  const pausedDesc = Object.getOwnPropertyDescriptor(MediaProto, "paused");
  const timeDesc = Object.getOwnPropertyDescriptor(MediaProto, "currentTime");
  // Media starts where the page puts it: 0, or a time the page sets. Whatever
  // it played on Chromium's real clock before the page clock took it over
  // (an autoplay during page load) is discarded, so every render agrees.
  const mediaState = (el) => {
    let s = media.get(el);
    if (!s) {
      s = { playing: el.autoplay || !pausedDesc.get.call(el), t: 0 };
      media.set(el, s);
    }
    return s;
  };
  Object.defineProperty(MediaProto, "currentTime", {
    configurable: true,
    get() { return timeDesc.get.call(this); },
    set(v) { mediaState(this).t = Number(v) || 0; timeDesc.set.call(this, v); },
  });
  MediaProto.play = function () {
    const s = mediaState(this);
    s.playing = true;
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  };
  MediaProto.pause = function () {
    const s = mediaState(this);
    if (s.playing) { s.playing = false; this.dispatchEvent(new Event("pause")); }
    realPause.call(this);
  };
  Object.defineProperty(MediaProto, "paused", {
    configurable: true,
    get() { const s = media.get(this); return s ? !s.playing : pausedDesc.get.call(this); },
  });
  const svgStart = new WeakMap();
  const stepMedia = (ms) => {
    for (const svg of document.querySelectorAll("svg")) {
      if (svg.ownerSVGElement || !svg.querySelector("animate, animateTransform, animateMotion, set")) continue;
      if (!svgStart.has(svg)) svgStart.set(svg, now - ms);
      if (!svg.animationsPaused()) svg.pauseAnimations();
      svg.setCurrentTime((now - svgStart.get(svg)) / 1000);
    }
    // Wait (in real time, off camera) for one of a media element's events.
    const until = (el, events, ms) => new Promise((resolve) => {
      const done = () => { for (const e of events) el.removeEventListener(e, done); resolve(); };
      for (const e of events) el.addEventListener(e, done);
      realSetTimeout(done, ms); // never wait on a broken source
    });
    // Bring one element to its page-clock time: first wait for its data if it
    // isn't loaded yet (a slow load delays the render, never changes a frame),
    // then seek and wait for the seek to land.
    const sync = async (el, s) => {
      if (el.readyState < 2 && !el.error && (el.currentSrc || el.src || el.querySelector("source"))) {
        await until(el, ["loadeddata", "error"], 5000);
      }
      if (el.error || el.readyState < 1) return;
      const d = el.duration;
      if (isFinite(d) && d > 0 && s.t >= d) {
        if (el.loop) s.t = s.t % d;
        else if (s.playing) { s.t = d; s.playing = false; el.dispatchEvent(new Event("ended")); }
      }
      if (Math.abs(timeDesc.get.call(el) - s.t) > 0.0005) {
        timeDesc.set.call(el, s.t); // the real setter: this isn't the page moving it
        await until(el, ["seeked"], 2000);
      }
    };
    const syncs = [];
    for (const el of document.querySelectorAll("video, audio")) {
      const s = mediaState(el);
      if (!pausedDesc.get.call(el)) realPause.call(el);
      // Its time moves with the page clock from the first frame, loaded or not.
      if (s.playing) s.t += (ms / 1000) * (el.playbackRate || 1);
      syncs.push(sync(el, s));
    }
    return syncs.length ? Promise.all(syncs) : undefined;
  };

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
    // An animation the page replays after it finished (play() again) is
    // running once more: take it back onto the frame clock.
    for (const a of document.getAnimations()) {
      if (finished.has(a) && a.playState === "running") {
        finished.delete(a);
        tracked.set(a, a.currentTime ?? 0);
        a.pause();
      }
    }
    // Step every running CSS transition / animation by exactly ms.
    for (const a of document.getAnimations()) {
      if (finished.has(a)) continue;
      let ct = tracked.get(a);
      const rate = a.playbackRate;
      const timing = a.effect && a.effect.getComputedTiming();
      const end = timing ? timing.endTime : Infinity;
      if (ct === undefined) {
        // New since last frame: restart it on this frame boundary (at its
        // end if it plays backwards).
        ct = rate < 0 && end !== Infinity ? end : 0;
      } else {
        // At its own playback rate: reverse() and playbackRate = 0.5 count.
        ct += ms * rate;
      }
      // play() or reverse() by the page resumes real-time playback; keep it paused.
      if (a.playState === "running") a.pause();
      if ((rate >= 0 && ct >= end) || (rate < 0 && ct <= 0)) {
        tracked.delete(a);
        finished.add(a);
        a.finish(); // to the end, or the start when reversed
      } else {
        a.currentTime = ct;
        tracked.set(a, ct);
      }
    }
    drawCaret();
    return stepMedia(ms);
  };
})();
`;

/** The page clock shim starting at the real current time (kept for existing imports). */
export const CLOCK_SHIM = clockShim(null);
