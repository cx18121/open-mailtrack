import { describe, expect, it } from "vitest";
import type { TrackedMessage } from "./api.js";
import { expandOperator } from "./search.js";

const msg = (over: Partial<TrackedMessage>): TrackedMessage => ({
  id: "x", subject: "s", recipients: [], gmail_thread_id: "t", sent_at: 1, created_at: 1,
  opens: 0, firstOpenAt: null, lastOpenAt: null, openAts: [], late: null, ...over,
});

describe("expandOperator", () => {
  const messages = [msg({ gmail_thread_id: "aa", opens: 2 }), msg({ gmail_thread_id: "bb" }), msg({ gmail_thread_id: "aa" }), msg({ gmail_thread_id: null, opens: 3 })];
  it("expands to gmail thread: groups without duplicates", () => {
    expect(expandOperator("has:opened", messages)).toBe("{thread:aa}");
    expect(expandOperator("has:unopened", messages)).toBe("{thread:bb thread:aa}");
  });
  it("never produces an empty group", () => {
    expect(expandOperator("has:opened", [])).toBe("thread:0");
  });
});
