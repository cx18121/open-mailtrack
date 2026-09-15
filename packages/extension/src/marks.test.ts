import { beforeAll, describe, expect, it } from "vitest";
import type { OpenSummary } from "./api.js";
import { rowTooltip, statusElement, summaryText } from "./marks.js";

const now = new Date("2026-09-15T20:00:00").getTime();
const h = (n: number) => now - n * 3_600_000;
const opened = (...ats: number[]): OpenSummary => ({
  opens: ats.length,
  firstOpenAt: ats[0] ?? null,
  lastOpenAt: ats.at(-1) ?? null,
  openAts: ats,
  late: null,
});

beforeAll(() => {
  (globalThis as any).chrome = { runtime: { getURL: (p: string) => `chrome-extension://x/${p}` } };
});

describe("summaryText", () => {
  it("covers unopened, once, and repeated in gmail's time (ago) form", () => {
    expect(summaryText(opened())).toEqual({ count: "Not opened yet", rest: "", late: "" });
    expect(summaryText(opened(h(2)), now)).toEqual({ count: "Opened", rest: "6:00 PM (2 hours ago)", late: "" });
    expect(summaryText(opened(h(30), h(2), h(1)), now)).toEqual({
      count: "Opened 3 times",
      rest: "· last 7:00 PM (1 hour ago)",
      late: "",
    });
  });

  it("names late opens", () => {
    expect(summaryText({ ...opened(h(1)), late: { kind: "after_send", days: 6 } }, now).late).toBe("6 days after sending");
    expect(summaryText({ ...opened(h(200), h(1)), late: { kind: "after_previous", days: 8 } }, now).late).toBe("reopened after 8 days");
  });
});

describe("rowTooltip", () => {
  it("is relative and thread-aware", () => {
    expect(rowTooltip({ tracked: 1, opens: 0, lastOpenAt: null, late: null })).toBe("Sent · not opened yet");
    expect(rowTooltip({ tracked: 2, opens: 0, lastOpenAt: null, late: null })).toBe("2 tracked · none opened yet");
    expect(rowTooltip({ tracked: 1, opens: 3, lastOpenAt: h(2), late: null }, now)).toBe("Opened 3 times · last 2 hours ago");
    expect(rowTooltip({ tracked: 1, opens: 2, lastOpenAt: h(2), late: { kind: "after_previous", days: 5 } }, now)).toBe(
      "Opened 2 times · last 2 hours ago · reopened after 5 days",
    );
  });
});

describe("statusElement", () => {
  it("renders a line, and a collapsed list only for repeated opens", () => {
    const one = statusElement(document, opened(h(1)), now);
    expect(one.querySelector(".omt-status-toggle")).toBeNull();
    expect(one.querySelector("img")!.src).toContain("opened.svg");

    const many = statusElement(document, opened(h(3), h(1)), now);
    const list = many.querySelector<HTMLUListElement>(".omt-status-list")!;
    expect(list.hidden).toBe(true);
    expect([...list.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["5:00 PMtoday", "7:00 PMtoday"]);
    const toggle = many.querySelector<HTMLButtonElement>(".omt-status-toggle")!;
    toggle.click();
    expect(list.hidden).toBe(false);
    expect(toggle.textContent).toBe("Hide");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    const none = statusElement(document, opened(), now);
    expect(none.querySelector("img")!.src).toContain("sent.svg");
    expect(none.textContent).toBe("Not opened yet");
  });

  it("shows a late badge", () => {
    const el = statusElement(document, { ...opened(h(1)), late: { kind: "after_send", days: 4 } }, now);
    expect(el.querySelector(".omt-status-late")!.textContent).toBe("4 days after sending");
  });
});
