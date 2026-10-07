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

  it("blocks direct and Gmail-proxied tracking pixels, but not other images", () => {
    const rule = pixelBlockRule("https://t.example.com");
    expect(rule.condition.initiatorDomains).toEqual(["mail.google.com"]);
    expect(rule.condition.resourceTypes).toEqual(["image"]);
    expect(rule.condition.isUrlFilterCaseSensitive).toBe(true);
    expect(rule.condition.regexFilter).toBeTypeOf("string");
    const matches = new RegExp(rule.condition.regexFilter!);
    const pixel = "https://t.example.com/p/abcdefghijklmnopqrstuv.gif";
    expect(matches.test(pixel)).toBe(true);
    expect(matches.test(`https://ci3.googleusercontent.com/meips/XYZ=s0-d-e1-ft#${pixel}`)).toBe(true);
    expect(matches.test(`https://ci4.googleusercontent.com/proxy/XYZ#${pixel}`)).toBe(true);
    for (const url of [
      "https://t.example.com/logo.png",
      "https://ci3.googleusercontent.com/meips/logo#https://cdn.example.org/logo.png",
      `https://not-google.example/image#${pixel}`,
      `https://ci3.googleusercontent.com.evil.example/image#${pixel}`,
      `https://ci3.googleusercontent.com/image?target=${pixel}`,
      "https://t.example.com.evil.example/p/abcdefghijklmnopqrstuv.gif",
      "https://t.example.com/p/a.b.gif",
      "https://t.example.com/p/nested/image.gif",
      "https://tXexampleYcom/p/abcdefghijklmnopqrstuv.gif",
    ]) expect(matches.test(url), url).toBe(false);
  });

  it("normalizes a trailing slash and escapes a configured server path", () => {
    const matches = new RegExp(pixelBlockRule("https://t.example.com/tracker.v1/").condition.regexFilter!);
    const pixel = "https://t.example.com/tracker.v1/p/abcdefghijklmnopqrstuv.gif";
    expect(matches.test(pixel)).toBe(true);
    expect(matches.test(`https://ci3.googleusercontent.com/meips/X#${pixel}`)).toBe(true);
    expect(matches.test(pixel.replace("tracker.v1", "trackerXv1"))).toBe(false);
  });
});
