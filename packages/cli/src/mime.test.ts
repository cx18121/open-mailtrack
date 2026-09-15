import { describe, expect, it } from "vitest";
import { buildRaw, textToHtml } from "./mime.js";

describe("textToHtml", () => {
  it("escapes html, links urls, and keeps line breaks", () => {
    expect(textToHtml("Hi <b>\nsee https://x.com/a?b=1. ok")).toBe(
      'Hi &lt;b&gt;<br>\nsee <a href="https://x.com/a?b=1">https://x.com/a?b=1</a>. ok',
    );
  });
});

describe("buildRaw", () => {
  it("produces multipart/alternative with the pixel only in the html part", () => {
    const raw = Buffer.from(
      buildRaw({ from: "Me <me@x.com>", to: "a@y.com", subject: "héllo", text: "line1\nline2", pixelUrl: "https://t/p/abc.gif" }),
      "base64url",
    ).toString();
    expect(raw).toContain("Subject: =?UTF-8?B?");
    expect(raw).toContain('Content-Type: multipart/alternative; boundary="alt_');
    const parts = raw.split(/--alt_[0-9a-f]+/);
    const decode = (part: string) => Buffer.from(part.split("\r\n\r\n")[1].trim(), "base64").toString();
    expect(decode(parts[1])).toBe("line1\nline2");
    expect(decode(parts[2])).toContain('<img src="https://t/p/abc.gif" width="1" height="1"');
    expect(decode(parts[2])).toContain("line1<br>\nline2");
  });
});
