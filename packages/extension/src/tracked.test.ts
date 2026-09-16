import { beforeAll, describe, expect, it, vi } from "vitest";
import type { TrackedMessage } from "./api.js";
import { rowText, trackedList } from "./tracked.js";

const now = new Date("2026-09-15T20:00:00").getTime();
const h = (n: number) => now - n * 3_600_000;
const msg = (over: Partial<TrackedMessage>): TrackedMessage => ({
  id: "x",
  subject: "Hello",
  recipients: ["ana@startup.io"],
  gmail_thread_id: "t1",
  sent_at: h(5),
  created_at: h(5),
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

describe("rowText", () => {
  it("describes unopened, single, and repeated opens relative to now", () => {
    expect(rowText(msg({}), now)).toBe("Sent 5 hours ago · not opened");
    expect(rowText(msg({ opens: 1, lastOpenAt: h(1) }), now)).toBe("Opened 1 hour ago");
    expect(rowText(msg({ opens: 3, lastOpenAt: h(2) }), now)).toBe("Opened 3 times, last 2 hours ago");
  });
});

describe("trackedList", () => {
  it("renders rows that open the thread and shows the late badge", () => {
    const onOpen = vi.fn();
    const el = trackedList(document, [msg({ opens: 1, lastOpenAt: h(1), late: { kind: "after_send", days: 3 } }), msg({ id: "y", gmail_thread_id: null })], onOpen, now);
    const rows = el.querySelectorAll(".omt-tracked-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].tagName).toBe("A");
    expect(rows[0].querySelector(".omt-status-late")!.textContent).toBe("3 days after sending");
    expect(rows[0].querySelector(".omt-tracked-to")!.textContent).toBe("ana");
    (rows[0] as HTMLAnchorElement).click();
    expect(onOpen).toHaveBeenCalledWith("t1");
    expect(rows[1].tagName).toBe("DIV");
  });

  it("has an empty state", () => {
    expect(trackedList(document, [], () => {}).textContent).toContain("No tracked messages yet");
  });
});
