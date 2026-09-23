export type Ease = "linear" | "smooth" | "snappy" | "overshoot";

export const easings: Record<Ease, (t: number) => number> = {
  linear: (t) => t,
  // easeInOutCubic — the default "human hand" feel
  smooth: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  // easeOutExpo — fast start, gentle landing
  snappy: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  // easeOutBack — slight overshoot past the target
  overshoot: (t) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
};

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Eased progress in [0,1] for a segment starting at `start` lasting `dur` ms. */
export function progress(t: number, start: number, dur: number, ease: Ease): number {
  if (dur <= 0) return 1;
  return easings[ease](clamp((t - start) / dur, 0, 1));
}
