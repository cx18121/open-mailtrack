import { describe, expect, it } from "vitest";
import { formatTable, parseDuration, type TrackedMessage } from "./status.js";

const now = 1_000_000_000_000;
const h = (n: number) => now - n * 3_600_000;
const msg = (over: Partial<TrackedMessage>): TrackedMessage => ({
  id: "x", subject: "Hello", recipients: ["a@b.co"], source: "cli", sent_at: h(30), created_at: h(30),
  gmail_message_id: "g", gmail_thread_id: "t", replied_at: null, opens: 0, firstOpenAt: null, lastOpenAt: null, openAts: [], late: null, ...over,
});

describe("parseDuration", () => {
  it("accepts m h d w and rejects junk", () => {
    expect(parseDuration("12h")).toBe(12 * 3_600_000);
    expect(parseDuration("2w")).toBe(14 * 86_400_000);
    expect(() => parseDuration("soon")).toThrow(/--since/);
  });
});

describe("formatTable", () => {
  it("aligns columns and describes opens and late flags", () => {
    const out = formatTable(
      [msg({ opens: 2, lastOpenAt: h(1), late: { kind: "after_send", days: 3 } }), msg({ subject: "Follow up", recipients: ["long.name@example.com"] })],
      now,
    );
    expect(out.split("\n")).toEqual([
      "a@b.co                 Hello      sent 1d ago  opened 2x, last 1h ago  3d after send",
      "long.name@example.com  Follow up  sent 1d ago  -",
    ]);
  });

  it("has an empty message", () => {
    expect(formatTable([])).toBe("No tracked messages.");
  });
});
