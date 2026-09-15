import { describe, expect, it } from "vitest";
import { newId, pixelBlockRule, pixelUrl } from "./tracking.js";

describe("tracking", () => {
  it("makes 22 char base64url ids the server accepts", () => {
    for (let i = 0; i < 50; i++) expect(newId()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("builds the pixel url the server serves", () => {
    expect(pixelUrl("https://t.example.com", "abc")).toBe("https://t.example.com/p/abc.gif");
  });

  it("blocks only pixel images loaded from gmail", () => {
    const rule = pixelBlockRule("https://t.example.com");
    expect(rule.condition).toEqual({
      urlFilter: "||t.example.com/p/",
      initiatorDomains: ["mail.google.com"],
      resourceTypes: ["image"],
    });
  });
});
