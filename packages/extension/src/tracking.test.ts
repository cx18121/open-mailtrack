import { describe, expect, it } from "vitest";
import { hasPixel, newId, pixelBlockRule, pixelUrl, removePixels } from "./tracking.js";

describe("tracking", () => {
  it("makes 22 char base64url ids the server accepts", () => {
    for (let i = 0; i < 50; i++) expect(newId()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("builds the pixel url the server serves", () => {
    expect(pixelUrl("https://t.example.com", "abc")).toBe("https://t.example.com/p/abc.gif");
  });

  it("removes our pixels whether direct, proxied, or attribute-marked, and keeps other images", () => {
    const div = document.createElement("div");
    div.innerHTML = `
      <img src="https://t.example.com/p/abc.gif" data-omt="abc">
      <div class="gmail_quote"><img src="https://ci3.googleusercontent.com/meips/XYZ=s0-d-e1-ft#https://t.example.com/p/old.gif"></div>
      <img src="https://cdn.example.org/logo.png">`;
    removePixels(div, "https://t.example.com");
    const srcs = [...div.querySelectorAll("img")].map((i) => i.src);
    expect(srcs).toEqual(["https://cdn.example.org/logo.png"]);
  });

  it("recognises our pixel inside inserted nodes, direct or proxied", () => {
    const wrap = document.createElement("div");
    wrap.innerHTML = `<div><img src="https://ci3.googleusercontent.com/meips/X=s0-d-e1-ft#https://t.example.com/p/abc.gif"></div>`;
    expect(hasPixel(wrap, "https://t.example.com")).toBe(true);
    const other = document.createElement("img");
    other.src = "https://cdn.example.org/logo.png";
    expect(hasPixel(other, "https://t.example.com")).toBe(false);
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
