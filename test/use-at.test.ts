import { describe, expect, it } from "vitest";
import { formatUseAt, isDue, parseUseAt, useAtIntervals, UseAtError } from "../src/use-at.js";

const HOUR = 3600_000;

describe("useAt", () => {
  it("reads a day as the whole local day (Helsinki is UTC+2 in November)", () => {
    const [day] = useAtIntervals(parseUseAt("2026-11-08"));
    expect(new Date(day!.from).toISOString()).toBe("2026-11-07T22:00:00.000Z");
    expect(new Date(day!.to).toISOString()).toBe("2026-11-08T21:59:59.999Z");
  });

  it("follows the summer time change: a day in July starts at 21:00 UTC the evening before", () => {
    const [day] = useAtIntervals(parseUseAt("2026-07-05"));
    expect(new Date(day!.from).toISOString()).toBe("2026-07-04T21:00:00.000Z");
  });

  it("reads an hour, a moment and a moment with a zone", () => {
    const [hour, moment, zoned] = useAtIntervals(parseUseAt("2026-11-08T10, 2026-11-08T10:30; 2026-11-08T10:30:15Z"));
    expect(new Date(hour!.from).toISOString()).toBe("2026-11-08T08:00:00.000Z");
    expect(hour!.to - hour!.from).toBe(HOUR - 1);
    expect(moment!.from).toBe(moment!.to);
    expect(new Date(moment!.from).toISOString()).toBe("2026-11-08T08:30:00.000Z");
    expect(new Date(zoned!.from).toISOString()).toBe("2026-11-08T10:30:15.000Z");
  });

  it("reads a range from the start of the first to the end of the last, and several entries", () => {
    const [range, second] = useAtIntervals(parseUseAt(["2026-11-08/2026-11-10", "2026-11-22"]));
    expect(new Date(range!.from).toISOString()).toBe("2026-11-07T22:00:00.000Z");
    expect(new Date(range!.to).toISOString()).toBe("2026-11-10T21:59:59.999Z");
    expect(second).toBeDefined();
    expect(parseUseAt("2026-11-08 10:00")).toEqual(["2026-11-08T10:00"]);
  });

  it("refuses what is not a date, an impossible date, a backwards range and too many entries", () => {
    for (const bad of ["tomorrow", "2026-02-30", "2026-11-08T25", "2026-11-10/2026-11-08", "2026-11-08/2026-11-09/2026-11-10", "2026-11-08T10:61"]) {
      expect(() => parseUseAt(bad), bad).toThrow(UseAtError);
    }
    expect(() => parseUseAt(Array.from({ length: 33 }, () => "2026-11-08"))).toThrow(/at most/);
    expect(() => parseUseAt("2026-11-08", "Mars/Olympus")).toThrow(/time zone/);
  });

  it("is due from the lead time before the first moment until the grace after the last", () => {
    const entries = parseUseAt("2026-11-08T10:00");
    const at = Date.parse("2026-11-08T08:00:00Z");
    expect(isDue(entries, "Europe/Helsinki", at - 48 * HOUR - 1, 48 * HOUR, 6 * HOUR)).toBe(false);
    expect(isDue(entries, "Europe/Helsinki", at - 48 * HOUR, 48 * HOUR, 6 * HOUR)).toBe(true);
    expect(isDue(entries, "Europe/Helsinki", at + 6 * HOUR, 48 * HOUR, 6 * HOUR)).toBe(true);
    expect(isDue(entries, "Europe/Helsinki", at + 6 * HOUR + 1, 48 * HOUR, 6 * HOUR)).toBe(false);
    expect(isDue(undefined, "Europe/Helsinki", at, HOUR, HOUR)).toBe(false);
    expect(formatUseAt(["a", "b"])).toBe("a, b");
  });
});
