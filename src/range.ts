import { RangeNotSatisfiableError } from "./errors.js";

/** An inclusive byte range, both ends already resolved against the object size. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Resolves a Range header against an object of `size` bytes.
 *
 * - No header, a malformed header, or several ranges: the whole object (RFC 9110 lets a server ignore Range).
 * - A single range outside the object, or any range on an empty object: throws RangeNotSatisfiableError (416).
 * - Otherwise returns the inclusive range, clipped to the object end.
 */
export function resolveRange(header: string | undefined, size: number): ByteRange | undefined {
  if (header === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const first = match[1] ?? "";
  const last = match[2] ?? "";
  if (first === "" && last === "") return undefined;

  if (first === "") {
    // Suffix range: the last N bytes.
    const suffix = Number(last);
    if (suffix === 0 || size === 0) throw new RangeNotSatisfiableError(size);
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(first);
  if (start >= size) throw new RangeNotSatisfiableError(size);
  const end = last === "" ? size - 1 : Number(last);
  if (end < start) return undefined;
  return { start, end: Math.min(end, size - 1) };
}

export function contentRange(range: ByteRange, size: number): string {
  return `bytes ${range.start}-${range.end}/${size}`;
}
