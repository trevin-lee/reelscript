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
  return CLOCK_SHIM_SOURCE.replace("__EPOCH__", epoch === null ? "Date.now()" : String(epoch)).replace("__PIN_NOW__", pinNow("epoch + now"));
}

/**
 * What else tells the time without a Date: Intl formatting "now" (format()
 * with no date) and Temporal.Now. Both read the real clock unless pointed at
 * the page's: `nowMs` is a JS expression for the page's current time in ms.
 */
function pinNow(nowMs: string): string {
  return String.raw`
  {
    const current = () => ${nowMs};
    const DTF = Intl.DateTimeFormat.prototype;
    const formatGetter = Object.getOwnPropertyDescriptor(DTF, "format").get;
    Object.defineProperty(DTF, "format", {
      configurable: true,
      get() { const f = formatGetter.call(this); return (d) => f(d === undefined ? current() : d); },
    });
    const realParts = DTF.formatToParts;
    DTF.formatToParts = function (d) { return realParts.call(this, d === undefined ? current() : d); };
    // A cookie the page sets to expire in 30 days, by its own date, would be long
    // expired by the real one Chromium judges it by, and dropped at once (a
    // consent banner that comes back): move expiries by the gap between them.
    const gap = () => RealDate.now() - current();
    const cookie = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
    Object.defineProperty(Document.prototype, "cookie", {
      configurable: true,
      get() { return cookie.get.call(this); },
      set(v) {
        cookie.set.call(this, String(v).replace(/;\s*expires=([^;]*)/i, (m, d) => {
          const t = RealDate.parse(d);
          return isNaN(t) ? m : "; expires=" + new RealDate(t + gap()).toUTCString();
        }));
      },
    });
    if (typeof cookieStore !== "undefined") {
      const set = cookieStore.set.bind(cookieStore);
      cookieStore.set = (a, b) => a && typeof a === "object" && typeof a.expires === "number" ? set({ ...a, expires: a.expires + gap() }) : set(a, b);
    }
    if (typeof Temporal !== "undefined" && Temporal.Now) {
      const T = Temporal;
      const zone = T.Now.timeZoneId;
      const zoned = (z) => T.Instant.fromEpochMilliseconds(current()).toZonedDateTimeISO(z === undefined ? zone() : z);
      T.Now.instant = () => T.Instant.fromEpochMilliseconds(current());
      T.Now.zonedDateTimeISO = zoned;
      T.Now.plainDateTimeISO = (z) => zoned(z).toPlainDateTime();
      T.Now.plainDateISO = (z) => zoned(z).toPlainDate();
      T.Now.plainTimeISO = (z) => zoned(z).toPlainTime();
    }
  }`;
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
${pinNow("RealDate.now() + offset")}
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
  // The page's own control of an animation: what it pauses stays paused, where
  // it seeks is where the clock goes on from, and what it finishes stays
  // finished. The clock steps animations through the originals, so its own
  // pausing isn't taken for the page's.
  const AP = Animation.prototype;
  const animPause = AP.pause;
  const animPlay = AP.play;
  const animReverse = AP.reverse;
  const animFinish = AP.finish;
  const timeOf = Object.getOwnPropertyDescriptor(AP, "currentTime");
  const held = new WeakSet(); // paused by the page
  AP.pause = function () { held.add(this); return animPause.call(this); };
  AP.play = function () { held.delete(this); return animPlay.call(this); };
  AP.reverse = function () { held.delete(this); return animReverse.call(this); };
  AP.finish = function () { held.delete(this); tracked.delete(this); finished.add(this); return animFinish.call(this); };
  Object.defineProperty(AP, "currentTime", {
    configurable: true,
    get() { return timeOf.get.call(this); },
    set(v) { if (v !== null) tracked.set(this, Number(v)); timeOf.set.call(this, v); },
  });
  // A CSS animation the page's style pauses (animation-play-state: paused).
  const styleHeld = (a) => {
    if (typeof CSSAnimation === "undefined" || !(a instanceof CSSAnimation) || !a.effect || !a.effect.target) return false;
    const cs = getComputedStyle(a.effect.target, a.effect.pseudoElement || null);
    const names = cs.animationName.split(/,\s*/);
    const states = cs.animationPlayState.split(/,\s*/);
    const i = names.indexOf(a.animationName);
    return (states[i < 0 ? 0 : i % states.length] || "running") === "paused";
  };
  const epoch = __EPOCH__;
  const RealDate = Date;

  const g = window;
  const realSetTimeout = window.setTimeout.bind(window);
  const realRAF = window.requestAnimationFrame.bind(window);
  // Let Chromium render the page on its own (real) frames, which is when it
  // delivers scroll events and IntersectionObserver callbacks: after a scroll
  // step, so a reveal-on-scroll starts on the same frame in every render.
  g.__reelscript_settle = () => new Promise((resolve) => realRAF(() => realRAF(() => resolve())));
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
__PIN_NOW__
  // Math.random, seeded, so a page that draws random numbers (chart data,
  // avatars, jitter) draws the same ones on every render.
  let seed = 0x9e3779b9;
  Math.random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };

  const call = (fn, args) => { try { typeof fn === "function" ? fn(...args) : new Function(String(fn))(); } catch (e) { console.error(e); } };

  // Web components keep their animations, media and text fields in shadow
  // roots, which document-wide queries don't reach. A closed root can only be
  // found through the host it was attached to, so those are remembered.
  const closedRoots = new WeakMap(); // host -> its closed shadow root
  const realAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const root = realAttachShadow.call(this, init);
    if (init && init.mode === "closed") closedRoots.set(this, root);
    return root;
  };
  const shadowOf = (el) => el.shadowRoot || closedRoots.get(el) || null;
  // The document and every shadow root in it, nested ones included.
  const scopes = () => {
    const found = [document];
    for (let i = 0; i < found.length; i++) {
      const start = found[i] === document ? document.documentElement : found[i];
      if (!start) continue;
      const walker = document.createTreeWalker(start, NodeFilter.SHOW_ELEMENT);
      for (let n = walker.currentNode; n; n = walker.nextNode()) {
        const root = shadowOf(n);
        if (root) found.push(root);
      }
    }
    return found;
  };

  // Text caret. Chromium blinks its own caret on real time, so two renders
  // would differ wherever a text field has focus. Its caret is hidden, and
  // this draws one at the same place instead: solid for half a second after
  // each edit, then blinking every half second, on the frame clock.
  let caret = null;
  let caretCss = null; // hides Chromium's caret in the document and in every shadow root
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
  const drawCaret = (roots) => {
    if (!document.documentElement) return;
    if (!caretCss) {
      caretCss = new CSSStyleSheet();
      caretCss.replaceSync("*, *::before, *::after { caret-color: transparent !important; }");
    }
    // Added again if the page replaces a scope's adopted sheets (Lit sets them on first render).
    for (const r of roots) if (!r.adoptedStyleSheets.includes(caretCss)) r.adoptedStyleSheets = [...r.adoptedStyleSheets, caretCss];
    let spot = null;
    // The focused element itself, inside whatever web components hold it.
    let el = document.activeElement;
    for (let r = el && shadowOf(el); r && r.activeElement; r = shadowOf(el)) el = r.activeElement;
    // Seen, as a target must be: not in anything faded all the way out (a closed modal).
    const visible = (e) => {
      const r = e.getBoundingClientRect();
      if (r.width <= 2 || r.height <= 2 || getComputedStyle(e).visibility !== "visible") return false;
      for (let n = e; n; n = n.parentElement || (n.getRootNode().host || null)) if (getComputedStyle(n).opacity === "0") return false;
      return true;
    };
    if (el && document.hasFocus() && visible(el)) {
      if ((el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && TEXT_TYPES.includes(el.type))) && el.selectionStart === el.selectionEnd && !el.readOnly) {
        try { spot = fieldCaret(el); } catch (e) { spot = null; }
      } else if (el.isContentEditable) {
        const scope = el.getRootNode();
        const sel = scope !== document && scope.getSelection ? scope.getSelection() : getSelection();
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
  const inScopes = (roots, selector) => roots.flatMap((r) => Array.from(r.querySelectorAll(selector)));
  const stepMedia = (ms, roots) => {
    for (const svg of inScopes(roots, "svg")) {
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
    // then seek and wait for the seek to land. Returns the source of media
    // that won't move, for the renderer to warn about.
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
        // A server that doesn't answer HTTP Range requests leaves it where it was.
        if (Math.abs(timeDesc.get.call(el) - s.t) > 0.05) return el.currentSrc || el.src;
      }
    };
    const syncs = [];
    for (const el of inScopes(roots, "video, audio")) {
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
    const roots = scopes();
    // A scroll-driven animation follows the scroll position, not time, and can't
    // be given a time: it's the page's, like the scrolling that drives it.
    const onTime = (a) => !a.timeline || typeof DocumentTimeline === "undefined" || a.timeline instanceof DocumentTimeline;
    const animations = () => roots.flatMap((r) => r.getAnimations()).filter(onTime);
    // An animation that hasn't started yet (one a click or class change set off
    // since the last frame) can't be held yet: Chromium may already be running
    // its copy on the compositor, and pausing it now can leave that copy a real
    // frame in, whatever time the page is set to. It's held once it has started,
    // at the next real frame, when the change reaches the compositor's copy too.
    const starting = [];
    const holdAt = (a, ct) => {
      if (a.pending) { starting.push(a); return; }
      if (a.playState === "running") animPause.call(a);
      timeOf.set.call(a, ct);
    };
    // An animation the page replays after it finished (play() again) is
    // running once more: take it back onto the frame clock.
    for (const a of animations()) {
      if (finished.has(a) && a.playState === "running") {
        finished.delete(a);
        const ct = timeOf.get.call(a) ?? 0;
        tracked.set(a, ct);
        holdAt(a, ct);
      }
    }
    // Step every running CSS transition / animation by exactly ms.
    for (const a of animations()) {
      if (finished.has(a)) continue;
      let ct = tracked.get(a);
      const rate = a.playbackRate;
      const timing = a.effect && a.effect.getComputedTiming();
      const end = timing ? timing.endTime : Infinity;
      // Held by the page: it stays where it is until the page plays it again.
      if (held.has(a) || styleHeld(a)) {
        if (a.playState === "running") animPause.call(a);
        if (ct === undefined) tracked.set(a, timeOf.get.call(a) ?? 0);
        continue;
      }
      if (ct === undefined) {
        // New since last frame: restart it on this frame boundary (at its
        // end if it plays backwards).
        ct = rate < 0 && end !== Infinity ? end : 0;
      } else {
        // At its own playback rate: reverse() and playbackRate = 0.5 count.
        ct += ms * rate;
      }
      // play() or reverse() by the page resumes real-time playback; keep it paused.
      if ((rate >= 0 && ct >= end) || (rate < 0 && ct <= 0)) {
        if (a.playState === "running") animPause.call(a);
        tracked.delete(a);
        finished.add(a);
        animFinish.call(a); // to the end, or the start when reversed
      } else {
        tracked.set(a, ct);
        holdAt(a, ct);
      }
    }
    drawCaret(roots);
    const media = stepMedia(ms, roots);
    if (!starting.length) return media;
    // Usually one real frame; never more than a quarter second.
    const started = Promise.all(starting.map((a) => a.ready.catch(() => {}))).then(() => new Promise((resolve) => realRAF(resolve)));
    return Promise.race([started, new Promise((resolve) => realSetTimeout(resolve, 250))]).then(() => {
      for (const a of starting) {
        if (a.playState === "idle" || finished.has(a) || held.has(a) || !tracked.has(a)) continue;
        if (a.playState === "running") animPause.call(a);
        timeOf.set.call(a, tracked.get(a));
      }
      return media;
    });
  };
})();
`;

/** The page clock shim starting at the real current time (kept for existing imports). */
export const CLOCK_SHIM = clockShim(null);
