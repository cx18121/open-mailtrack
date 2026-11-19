import { beforeAll, describe, expect, it, vi } from "vitest";
import type { TrackedMessage } from "./api.js";
import { rowText, trackedList, type ListState } from "./tracked.js";

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

const state = (over: Partial<ListState> = {}): ListState => ({
  filter: "all", expanded: new Set(), onFilter: () => {}, onOpen: () => {}, onToggle: () => {}, ...over,
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
    const el = trackedList(document, [msg({ opens: 1, lastOpenAt: h(1), late: { kind: "after_send", days: 3 } }), msg({ id: "y", gmail_thread_id: null })], state({ onOpen }), now);
    const rows = el.querySelectorAll(".omt-tracked-row");
    expect(rows).toHaveLength(2);
    expect([...el.querySelectorAll(".omt-chip")].map((c) => c.textContent)).toEqual(["All2", "Opened1", "Not opened1"]);
    expect(rows[0].tagName).toBe("A");
    expect(rows[0].querySelector(".omt-status-late")!.textContent).toBe("3 days after sending");
    expect(rows[0].querySelector(".omt-tracked-to")!.textContent).toBe("ana");
    (rows[0] as HTMLAnchorElement).click();
    expect(onOpen.mock.calls[0][0].gmail_thread_id).toBe("t1");
    expect(rows[1].tagName).toBe("A");
    expect(rows[1].getAttribute("href")).toContain("#search/");
    (rows[1] as HTMLAnchorElement).click();
    expect(onOpen.mock.calls[1][0]).toMatchObject({ id: "y", gmail_thread_id: null });
  });

  it("preserves browser navigation for modified clicks", () => {
    const onOpen = vi.fn();
    const el = trackedList(document, [msg({})], state({ onOpen }), now);
    const row = el.querySelector("a")!;
    expect(row.getAttribute("href")).toBe("#all/t1");
    const event = new MouseEvent("click", { ctrlKey: true, cancelable: true });
    row.dispatchEvent(event);
    expect(onOpen).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("filters by chip and reports the change", () => {
    const onFilter = vi.fn();
    const el = trackedList(document, [msg({ opens: 1, lastOpenAt: h(1) }), msg({ id: "y" })], state({ filter: "unopened", onFilter }), now);
    expect(el.querySelectorAll(".omt-tracked-row")).toHaveLength(1);
    el.querySelectorAll<HTMLButtonElement>(".omt-chip")[1].click();
    expect(onFilter).toHaveBeenCalledWith("opened");
  });

  it("expands an opened row to its open times without opening the thread", () => {
    const onOpen = vi.fn();
    const onToggle = vi.fn();
    const opened = msg({ opens: 2, firstOpenAt: h(3), lastOpenAt: h(1), openAts: [h(3), h(1)] });
    const collapsed = trackedList(document, [opened, msg({ id: "y" })], state({ onOpen, onToggle }), now);
    const toggles = collapsed.querySelectorAll<HTMLButtonElement>(".omt-tracked-toggle");
    expect(toggles).toHaveLength(1);
    expect(toggles[0].getAttribute("aria-expanded")).toBe("false");
    expect(collapsed.querySelector(".omt-tracked-opens")).toBeNull();
    toggles[0].click();
    expect(onToggle).toHaveBeenCalledWith("x");
    expect(onOpen).not.toHaveBeenCalled();

    const open = trackedList(document, [opened], state({ expanded: new Set(["x"]) }), now);
    expect(open.querySelector(".omt-tracked-toggle")!.getAttribute("aria-expanded")).toBe("true");
    expect([...open.querySelectorAll(".omt-tracked-opens li")].map((li) => li.textContent)).toEqual(["5:00 PMtoday", "7:00 PMtoday"]);
  });

  it("has empty states", () => {
    expect(trackedList(document, [], state()).textContent).toContain("No tracked messages yet");
    expect(trackedList(document, [msg({})], state({ filter: "opened" })).textContent).toContain("Nothing here right now");
  });
});
