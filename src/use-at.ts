/**
 * `useAt`: when an object is meant to be used (a service graphic, a rundown, a hymn sheet), so that
 * the cache can have it ready beforehand. The same format is meant for other Pi files as well.
 *
 * A value is a list of entries. Each entry is one of
 *   2026-11-08                  a whole day
 *   2026-11-08T10               a whole hour
 *   2026-11-08T10:30            a moment (seconds and a zone such as Z or +02:00 are allowed)
 *   2026-11-08/2026-11-10       a range from the start of the first to the end of the last
 *                               (any two of the forms above, joined with "/")
 * A string holds several entries separated by "," or ";". A date or time without a zone is local
 * time in the configured zone (default Europe/Helsinki).
 *
 * Zero dependencies, so the file can be copied into other services.
 */

export class UseAtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UseAtError";
  }
}

export const MAX_USE_AT_ENTRIES = 32;
export const DEFAULT_TIMEZONE = "Europe/Helsinki";

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HOUR = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/;
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?$/;

export interface UseInterval {
  /** Milliseconds since the epoch, inclusive. */
  from: number;
  /** Milliseconds since the epoch, inclusive. A moment has from === to. */
  to: number;
}

export function assertTimezone(zone: string): string {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return zone;
  } catch {
    throw new UseAtError(`unknown time zone: ${zone}`);
  }
}

/** Offset of `zone` from UTC at the instant `ms`, in milliseconds (east is positive). */
function zoneOffset(ms: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(new Date(ms));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The instant at which the clocks in `zone` show the given date and time. */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, zone: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const first = zoneOffset(guess, zone);
  const t = guess - first;
  const second = zoneOffset(t, zone);
  return second === first ? t : guess - second;
}

function checkParts(text: string, y: number, mo: number, d: number, h = 0, mi = 0, s = 0): void {
  const probe = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) {
    throw new UseAtError(`not a real date or time: ${text}`);
  }
}

interface Part {
  start: number;
  end: number;
}

function parsePart(text: string, zone: string): Part {
  let m = DATE.exec(text);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    checkParts(text, y, mo, d);
    return { start: zonedToUtc(y, mo, d, 0, 0, 0, zone), end: zonedToUtc(y, mo, d + 1, 0, 0, 0, zone) - 1 };
  }
  m = HOUR.exec(text);
  if (m) {
    const [y, mo, d, h] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    checkParts(text, y, mo, d, h);
    const start = zonedToUtc(y, mo, d, h, 0, 0, zone);
    return { start, end: start + 3600_000 - 1 };
  }
  m = DATETIME.exec(text);
  if (m) {
    const [y, mo, d, h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
    checkParts(text, y, mo, d, h, mi, s);
    let at: number;
    if (m[7]) {
      const offset = m[7] === "Z" ? 0 : (m[7].startsWith("-") ? -1 : 1) * (Number(m[7].slice(1, 3)) * 60 + Number(m[7].slice(-2))) * 60_000;
      at = Date.UTC(y, mo - 1, d, h, mi, s) - offset;
    } else {
      at = zonedToUtc(y, mo, d, h, mi, s, zone);
    }
    return { start: at, end: at };
  }
  throw new UseAtError(`not a date, hour or time (use 2026-11-08, 2026-11-08T10 or 2026-11-08T10:30): ${text}`);
}

function parseEntry(entry: string, zone: string): UseInterval {
  const sides = entry.split("/");
  if (sides.length > 2) throw new UseAtError(`a range has two ends: ${entry}`);
  const first = parsePart(sides[0]!, zone);
  const last = sides.length === 2 ? parsePart(sides[1]!, zone) : first;
  if (last.end < first.start) throw new UseAtError(`the range ends before it starts: ${entry}`);
  return { from: first.start, to: last.end };
}

/**
 * Checks a value and returns it as a clean list of entries. Accepts a string (several entries
 * separated by "," or ";") or a list of strings. Throws UseAtError when something is not valid.
 */
export function parseUseAt(input: string | readonly string[] | undefined, zone: string = DEFAULT_TIMEZONE): string[] {
  if (input === undefined) return [];
  const raw = (typeof input === "string" ? input.split(/[;,]/) : [...input]).map((e) => e.trim().replace(/ /g, "T")).filter((e) => e !== "");
  if (raw.length > MAX_USE_AT_ENTRIES) throw new UseAtError(`at most ${MAX_USE_AT_ENTRIES} entries`);
  assertTimezone(zone);
  for (const entry of raw) {
    if (entry.length > 64) throw new UseAtError(`entry too long: ${entry.slice(0, 20)}...`);
    parseEntry(entry, zone);
  }
  return raw;
}

/** The entries as time intervals. Entries are expected to have been through parseUseAt. */
export function useAtIntervals(entries: readonly string[], zone: string = DEFAULT_TIMEZONE): UseInterval[] {
  return entries.map((entry) => parseEntry(entry, zone));
}

/**
 * True when `now` is inside any interval, widened by `leadMs` before it and `graceMs` after it:
 * the object should be ready locally and kept until the grace has passed.
 */
export function isDue(
  entries: readonly string[] | undefined,
  zone: string,
  now: number,
  leadMs: number,
  graceMs: number
): boolean {
  if (!entries || entries.length === 0) return false;
  return useAtIntervals(entries, zone).some((i) => now >= i.from - leadMs && now <= i.to + graceMs);
}

/** The text form used in headers and S3 metadata. */
export function formatUseAt(entries: readonly string[]): string {
  return entries.join(", ");
}
