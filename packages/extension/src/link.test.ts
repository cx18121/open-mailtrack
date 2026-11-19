import { describe, expect, it } from "vitest";
import { messageSearch, ownPixelId } from "./link.js";
import type { TrackedMessage } from "./api.js";

const server = "https://t.example.com";
const id = "AAAAAAAAAAAAAAAAAAAAAA";
const other = "BBBBBBBBBBBBBBBBBBBBBB";
const pixel = (id: string) => `${server}/p/${id}.gif`;
const body = (html: string) => {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
};
const quoted = (img: HTMLImageElement) => !!img.closest("blockquote");

describe("ownPixelId", () => {
  it.each([pixel(id), `https://ci3.googleusercontent.com/meips/X#${pixel(id)}`])("reads an exact own pixel from %s", (src) => {
    expect(ownPixelId(body(`<img src="${src}">`), server, quoted)).toBe(id);
  });

  it("ignores quoted pixels and ambiguous bodies", () => {
    expect(ownPixelId(body(`<blockquote><img src="${pixel(id)}"></blockquote>`), server, quoted)).toBeNull();
    // InboxSDK 2.2.24 only recognizes BLOCKQUOTE, not Gmail's own quoted DIVs.
    expect(ownPixelId(body(`<div class="gmail_quote"><img src="${pixel(id)}"></div>`), server, quoted)).toBeNull();
    expect(ownPixelId(body(`<div class="gmail_quote_container"><img src="${pixel(id)}"></div>`), server, quoted)).toBeNull();
    expect(ownPixelId(body(`<img src="${pixel(id)}"><blockquote><img src="${pixel(other)}"></blockquote>`), server, quoted)).toBe(id);
    expect(ownPixelId(body(`<img src="${pixel(id)}"><img src="${pixel(other)}">`), server, quoted)).toBeNull();
  });

  it.each([
    `https://t.example.com.evil.test/p/${id}.gif`,
    `https://evil.test/#${pixel(id)}`,
    `${pixel(id)}?extra=1`,
    `${server}/p/short.gif`,
    `https://ci3.googleusercontent.com.evil.test/X#${pixel(id)}`,
  ])("does not trust lookalike or malformed URLs: %s", (src) => {
    expect(ownPixelId(body(`<img data-omt="${id}" src="${src}">`), server, quoted)).toBeNull();
  });
});

describe("messageSearch", () => {
  it("narrows the fallback to sent mail, recipient, subject and original send date", () => {
    const query = messageSearch({ recipients: ["ana@example.com"], subject: "Hello", sent_at: null, created_at: Date.UTC(2026, 8, 15, 20) } as TrackedMessage);
    expect(query).toBe('in:sent to:"ana@example.com" subject:"Hello" after:2026/09/14 before:2026/09/17');
  });

  it("keeps subject search operators inside the quoted value", () => {
    const query = messageSearch({ recipients: [], subject: 'Hi" OR in:anywhere\\\n', sent_at: 0, created_at: 0 } as unknown as TrackedMessage);
    expect(query).toContain('subject:"Hi  OR in:anywhere  "');
  });
});
