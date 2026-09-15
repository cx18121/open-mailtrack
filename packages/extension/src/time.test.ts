import { describe, expect, it } from "vitest";
import { ago, day, when } from "./time.js";

const now = new Date("2026-09-15T20:00:00").getTime();
const m = (n: number) => now - n * 60_000;
const h = (n: number) => now - n * 3_600_000;
const d = (n: number) => now - n * 86_400_000;

describe("ago", () => {
  it("scales from just now to a date", () => {
    expect(ago(m(0.5), now)).toBe("just now");
    expect(ago(m(5), now)).toBe("5 min ago");
    expect(ago(h(1), now)).toBe("1 hour ago");
    expect(ago(h(2), now)).toBe("2 hours ago");
    expect(ago(d(1), now)).toBe("yesterday");
    expect(ago(d(3), now)).toBe("3 days ago");
    expect(ago(d(20), now)).toBe("Aug 26");
  });
});

describe("when and day", () => {
  it("drops the date for today and yesterday", () => {
    expect(when(h(2), now)).toBe("6:00 PM");
    expect(when(d(1), now)).toBe("yesterday 8:00 PM");
    expect(when(d(3), now)).toBe("Sep 12, 8:00 PM");
    expect(day(h(1), now)).toBe("today");
    expect(day(d(1), now)).toBe("yesterday");
    expect(day(d(3), now)).toBe("Sep 12");
  });
});
