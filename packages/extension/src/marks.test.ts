import { describe as suite, expect, it } from "vitest";
import { describe, label } from "./marks.js";

suite("marks", () => {
  it("describes unopened, single, and repeated opens", () => {
    expect(describe({ opens: 0, firstOpenAt: null, lastOpenAt: null })).toBe("Not opened yet");
    expect(describe({ opens: 1, firstOpenAt: 0, lastOpenAt: 0 })).toMatch(/^Opened once, first /);
    expect(describe({ opens: 3, firstOpenAt: 0, lastOpenAt: 60_000 })).toMatch(/^Opened 3 times, first .*, last /);
  });

  it("uses one check for sent and two for opened", () => {
    expect(label({ opens: 0, firstOpenAt: null, lastOpenAt: null }).title).toBe("✓");
    expect(label({ opens: 2, firstOpenAt: 0, lastOpenAt: 0 }).title).toBe("✓✓ 2");
  });
});
