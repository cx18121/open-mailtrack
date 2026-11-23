import { describe, expect, it } from "vitest";
import { compileMime, injectPixelIntoHtml, parseDraftMime, stripServerPixelsFromHtml } from "./mime.js";

describe("mime", () => {
  it("strips our server pixels (direct, proxy, or data-omt) while keeping normal images", () => {
    const html = [
      '<p>Hello</p>',
      '<img src="https://example.com/logo.png">',
      '<img src="https://t.example.com/p/aaaaaaaaaaaaaaaaaaaaaa.gif" width="1">',
      '<img src="https://ci3.googleusercontent.com/meips/abc#https://t.example.com/p/bbbbbbbbbbbbbbbbbbbbbb.gif">',
      '<img data-omt="ccc" src="https://other.invalid/x.gif">',
    ].join("");
    const cleaned = stripServerPixelsFromHtml(html, "https://t.example.com");
    expect(cleaned).toContain("https://example.com/logo.png");
    expect(cleaned).not.toContain("t.example.com/p/");
    expect(cleaned).not.toContain("data-omt");
  });

  it("injects tracking pixel before </body> or at the end", () => {
    const url = "https://t.example.com/p/1234567890123456789012.gif";
    expect(injectPixelIntoHtml("<html><body><p>Hi</p></body></html>", url)).toContain(
      `<img src="${url}" width="1" height="1" alt="" style="border:0;width:1px;height:1px"></body>`,
    );
    expect(injectPixelIntoHtml("<p>Hi</p>", url)).toContain(`<p>Hi</p><img src="${url}"`);
  });

  it("compiles and round-trips RFC822 MIME with attachments, threading headers, and optional Bcc", async () => {
    const recipientCopy = await compileMime({
      from: "Charlie <charlie@cornell.edu>",
      to: ["alice@example.com", "bob@example.com"],
      cc: ["carol@example.com"],
      subject: "Re: Project update",
      html: "<p>Hi team</p>",
      inReplyTo: "<prev@example.com>",
      references: "<root@example.com> <prev@example.com>",
      messageId: "<copy-1@cornell.edu>",
      attachments: [
        {
          filename: "notes.txt",
          contentType: "text/plain",
          contentBase64: Buffer.from("attachment content").toString("base64"),
        },
      ],
    });
    const rawStr = recipientCopy.toString("utf8");
    expect(rawStr).not.toContain("Bcc:");
    expect(rawStr).toContain("In-Reply-To: <prev@example.com>");

    const parsed = await parseDraftMime(recipientCopy);
    expect(parsed.subject).toBe("Re: Project update");
    expect(parsed.inReplyTo).toBe("<prev@example.com>");
    expect(parsed.references).toBe("<root@example.com> <prev@example.com>");
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].filename).toBe("notes.txt");
    expect(Buffer.from(parsed.attachments[0].contentBase64, "base64").toString("utf8")).toBe("attachment content");

    const sentCopy = await compileMime({
      from: "Charlie <charlie@cornell.edu>",
      to: ["alice@example.com"],
      includeBccHeader: ["secret@example.com"],
      subject: "Hello",
      html: "<p>No pixel</p>",
      messageId: "<clean@cornell.edu>",
    });
    expect(sentCopy.toString("utf8")).toContain("Bcc: secret@example.com");
  });
});
