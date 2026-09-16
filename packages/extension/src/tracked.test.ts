import { beforeAll, describe, expect, it, vi } from "vitest";
import type { TrackedMessage } from "./api.js";
import { bucketsOf, rowText, trackedPage } from "./tracked.js";

const now = new Date("2026-09-15T20:00:00").getTime();
const h = (n: number) => now - n * 3_600_000;
const d = (n: number) => now - n * 86_400_000;
const msg = (over: Partial<TrackedMessage>): TrackedMessage => ({
  id: "x",
  subject: "Hello",
  recipients: ["ana@startup.io"],
  gmail_thread_id: "t1",
  sent_at: h(5),
  created_at: h(5),
  replied_at: null,
  opens: 0,
  firstOpenAt: null,
  lastOpenAt: null,
  openAts: [],
  late: null,
  ...over,
});

beforeAll(() => {
  (globalThis as any).chrome = { runtime: { getURL: (p: string) => `chrome-extension://x/${p}` } };
});

describe("bucketsOf", () => {
  it("routes by reply, recency, and silence", () => {
    expect(bucketsOf(msg({ replied_at: h(1), opens: 2, lastOpenAt: d(5) }), 3, now)).toEqual(["all", "replied"]);
    expect(bucketsOf(msg({ opens: 1, lastOpenAt: h(2) }), 3, now)).toEqual(["all", "recent"]);
    expect(bucketsOf(msg({ opens: 1, lastOpenAt: d(4) }), 3, now)).toEqual(["all", "follow_up"]);
    expect(bucketsOf(msg({ opens: 1, lastOpenAt: d(2) }), 3, now)).toEqual(["all"]);
    expect(bucketsOf(msg({ sent_at: d(4), created_at: d(4) }), 3, now)).toEqual(["all", "unopened"]);
    expect(bucketsOf(msg({}), 3, now)).toEqual(["all"]);
  });
});

describe("rowText", () => {
  it("describes replied, unopened, single, and repeated opens", () => {
    expect(rowText(msg({ replied_at: h(1), opens: 1, lastOpenAt: h(2) }), now)).toBe("Replied 1 hour ago");
    expect(rowText(msg({}), now)).toBe("Sent 5 hours ago · not opened");
    expect(rowText(msg({ opens: 1, lastOpenAt: h(1) }), now)).toBe("Opened 1 hour ago");
    expect(rowText(msg({ opens: 3, lastOpenAt: h(2) }), now)).toBe("Opened 3 times, last 2 hours ago");
  });
});

describe("trackedPage", () => {
  const messages = [
    msg({ id: "a", subject: "Follow me", opens: 1, lastOpenAt: d(5), late: { kind: "after_send", days: 3 } }),
    msg({ id: "b", subject: "Fresh", opens: 1, lastOpenAt: h(1) }),
    msg({ id: "c", subject: "Silent", sent_at: d(6), created_at: d(6), gmail_thread_id: null }),
    msg({ id: "d", subject: "Done", replied_at: h(3), opens: 1, lastOpenAt: d(2) }),
  ];

  it("shows chip counts and only the active bucket's rows", () => {
    const el = trackedPage(document, messages, { bucket: "follow_up", quietDays: 3 }, () => {}, () => {}, now);
    const chips = [...el.querySelectorAll(".omt-chip")].map((c) => c.textContent);
    expect(chips).toEqual(["Needs follow-up1", "Not opened1", "Recent opens1", "Replied1", "All4"]);
    const rows = el.querySelectorAll(".omt-tracked-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector(".omt-tracked-subject")!.textContent).toBe("Follow me");
    expect(rows[0].querySelector(".omt-status-late")!.textContent).toBe("3 days after sending");
  });

  it("switches bucket and quiet days through onState, and opens threads", () => {
    const onState = vi.fn();
    const onOpen = vi.fn();
    const el = trackedPage(document, messages, { bucket: "all", quietDays: 3 }, onState, onOpen, now);
    (el.querySelectorAll<HTMLButtonElement>(".omt-chip")[1]).click();
    expect(onState).toHaveBeenCalledWith({ bucket: "unopened", quietDays: 3 });
    const input = el.querySelector<HTMLInputElement>(".omt-quiet input")!;
    input.value = "7";
    input.dispatchEvent(new Event("change"));
    expect(onState).toHaveBeenCalledWith({ bucket: "all", quietDays: 7 });
    (el.querySelector<HTMLAnchorElement>("a.omt-tracked-row")!).click();
    expect(onOpen).toHaveBeenCalledWith("t1");
    expect(el.querySelectorAll(".omt-tracked-row")).toHaveLength(4);
  });

  it("has empty states for nothing tracked and an empty bucket", () => {
    expect(trackedPage(document, [], { bucket: "all", quietDays: 3 }, () => {}, () => {}).textContent).toContain("No tracked messages yet");
    expect(trackedPage(document, messages, { bucket: "recent", quietDays: 3 }, () => {}, () => {}, now + 2 * 86_400_000).textContent).toContain("Nothing here right now");
  });
});
