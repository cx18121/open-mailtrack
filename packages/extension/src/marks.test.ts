import { beforeAll, describe, expect, it } from "vitest";
import { rowTooltip, statusElement, summaryText } from "./marks.js";

const now = new Date("2026-09-15T20:00:00").getTime();
const h = (n: number) => now - n * 3_600_000;

beforeAll(() => {
  (globalThis as any).chrome = { runtime: { getURL: (p: string) => `chrome-extension://x/${p}` } };
});

describe("summaryText", () => {
  it("covers unopened, once, and repeated in gmail's time (ago) form", () => {
    expect(summaryText({ opens: 0, firstOpenAt: null, lastOpenAt: null, openAts: [] })).toEqual({ count: "Not opened yet", rest: "" });
    expect(summaryText({ opens: 1, firstOpenAt: h(2), lastOpenAt: h(2), openAts: [h(2)] }, now)).toEqual({
      count: "Opened",
      rest: "6:00 PM (2 hours ago)",
    });
    expect(summaryText({ opens: 3, firstOpenAt: h(30), lastOpenAt: h(1), openAts: [h(30), h(2), h(1)] }, now)).toEqual({
      count: "Opened 3 times",
      rest: "· last 7:00 PM (1 hour ago)",
    });
  });
});

describe("rowTooltip", () => {
  it("is relative and thread-aware", () => {
    expect(rowTooltip({ tracked: 1, opens: 0, lastOpenAt: null } as any)).toBe("Sent · not opened yet");
    expect(rowTooltip({ tracked: 2, opens: 0, lastOpenAt: null } as any)).toBe("2 tracked · none opened yet");
    expect(rowTooltip({ tracked: 1, opens: 3, lastOpenAt: h(2) } as any, now)).toBe("Opened 3 times · last 2 hours ago");
  });
});

describe("statusElement", () => {
  it("renders a line, and a collapsed details list only for repeated opens", () => {
    const one = statusElement(document, { opens: 1, firstOpenAt: h(1), lastOpenAt: h(1), openAts: [h(1)] }, now);
    expect(one.querySelector(".omt-status-toggle")).toBeNull();
    expect(one.querySelector("img")!.src).toContain("opened.svg");

    const many = statusElement(document, { opens: 2, firstOpenAt: h(3), lastOpenAt: h(1), openAts: [h(3), h(1)] }, now);
    const list = many.querySelector<HTMLUListElement>(".omt-status-list")!;
    expect(list.hidden).toBe(true);
    expect([...list.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["5:00 PMtoday", "7:00 PMtoday"]);
    const toggle = many.querySelector<HTMLButtonElement>(".omt-status-toggle")!;
    toggle.click();
    expect(list.hidden).toBe(false);
    expect(toggle.textContent).toBe("Hide");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    const none = statusElement(document, { opens: 0, firstOpenAt: null, lastOpenAt: null, openAts: [] }, now);
    expect(none.querySelector("img")!.src).toContain("sent.svg");
    expect(none.textContent).toBe("Not opened yet");
  });
});
