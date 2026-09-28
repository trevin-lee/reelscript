/** The demo's clock: one pinned moment shared by the page's Date and the menu bar. */

export const DEFAULT_CLOCK = "2025-09-23T09:41:00";
export const DEFAULT_TIMEZONE = "UTC";

/** Offset (ms) of `timeZone` from UTC at the instant `ms`. */
function zoneOffset(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(ms);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - (ms - (ms % 1000));
}

/**
 * The instant a clock setting names. A Date or an ISO string with an offset
 * ("Z", "+02:00") is taken as is; an ISO string without one is a wall-clock
 * time in `timeZone`.
 */
export function clockEpoch(clock: string | Date, timeZone: string): number {
  if (clock instanceof Date) return clock.getTime();
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(clock)) {
    const ms = Date.parse(clock);
    if (Number.isNaN(ms)) throw new Error(`reelscript: can't read clock "${clock}"`);
    return ms;
  }
  const m = clock.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) throw new Error(`reelscript: can't read clock "${clock}"; use an ISO date like "2026-03-10T14:30"`);
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  let ms = asUtc - zoneOffset(asUtc, timeZone);
  ms = asUtc - zoneOffset(ms, timeZone); // settle across a DST change
  return ms;
}

/** How the macOS menu bar shows a moment: "Tue Sep 23  9:41 AM". */
export function menubarClock(epoch: number, timeZone: string): string {
  const day = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(epoch).replace(",", "");
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(epoch);
  return `${day}  ${time}`;
}
