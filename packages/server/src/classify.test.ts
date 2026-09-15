import { describe, expect, it } from "vitest";
import { classifyHit, summarize } from "./classify.js";

const PROXY = "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)";
const hit = (at: number) => ({ at, user_agent: PROXY });

describe("classifyHit", () => {
  it("marks the sender's own view: proxy hit 10ms before the view signal (matrix, smoke 1)", () => {
    expect(classifyHit(hit(1789499643286), [1789499643296]).kind).toBe("self_view");
  });

  it("marks a hit shortly after the view signal as self view (collapsed message expanded)", () => {
    expect(classifyHit(hit(1000 + 12_000), [1000]).kind).toBe("self_view");
  });

  it("does not attribute a hit well outside the view window to the sender", () => {
    expect(classifyHit(hit(1000 + 60_000), [1000]).kind).toBe("open");
    expect(classifyHit(hit(1000 - 30_000), [1000]).kind).toBe("open");
  });

  it("treats a recipient's proxy fetch with no view signal as an open (matrix, ext 1)", () => {
    expect(classifyHit(hit(1789500109100), []).kind).toBe("open");
  });
});

describe("summarize", () => {
  it("counts sessions, not renders: matrix ext 1 had web, hard refresh, and ios opens", () => {
    const s = summarize([
      { at: 1789500109100, kind: "open", reason: "" },
      { at: 1789501353180, kind: "open", reason: "" },
      { at: 1789501524320, kind: "open", reason: "" },
    ]);
    expect(s).toEqual({ opens: 3, firstOpenAt: 1789500109100, lastOpenAt: 1789501524320, openAts: [1789500109100, 1789501353180, 1789501524320] });
  });

  it("collapses double fetches within 10 seconds and ignores self views", () => {
    const s = summarize([
      { at: 1000, kind: "open", reason: "" },
      { at: 1800, kind: "open", reason: "" },
      { at: 50_000, kind: "self_view", reason: "" },
    ]);
    expect(s).toEqual({ opens: 1, firstOpenAt: 1000, lastOpenAt: 1000, openAts: [1000] });
  });

  it("is empty with no opens", () => {
    expect(summarize([])).toEqual({ opens: 0, firstOpenAt: null, lastOpenAt: null, openAts: [] });
  });
});
