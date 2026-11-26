import { createHash } from "node:crypto";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import PostalMime from "postal-mime";

export type MimeAttachment = {
  filename?: string;
  contentType: string;
  /** Base64-encoded content so snapshots serialize cleanly to JSON. */
  contentBase64: string;
  cid?: string;
  disposition?: "inline" | "attachment";
};

export type ParsedDraft = {
  from?: string;
  subject?: string;
  html?: string;
  text?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  attachments: MimeAttachment[];
};

export async function parseDraftMime(raw: Buffer): Promise<ParsedDraft> {
  const parsed = await new PostalMime().parse(raw);
  const header = (name: string) => parsed.headers.find((h) => h.key === name.toLowerCase())?.value;
  const attachments: MimeAttachment[] = (parsed.attachments ?? []).map((att) => ({
    filename: att.filename ?? undefined,
    contentType: att.mimeType || "application/octet-stream",
    contentBase64: (
      att.content instanceof Uint8Array
        ? Buffer.from(att.content)
        : typeof att.content === "string"
          ? Buffer.from(att.content, "utf8")
          : Buffer.from(new Uint8Array(att.content))
    ).toString("base64"),
    cid: att.contentId ? att.contentId.replace(/^<|>$/g, "") : undefined,
    disposition: att.disposition === "inline" ? "inline" : "attachment",
  }));

  const from = parsed.from?.address
    ? parsed.from.name
      ? `${parsed.from.name} <${parsed.from.address}>`
      : parsed.from.address
    : undefined;

  return {
    from,
    subject: parsed.subject ?? undefined,
    html: parsed.html ?? undefined,
    text: parsed.text ?? undefined,
    messageId: parsed.messageId ?? header("message-id"),
    inReplyTo: parsed.inReplyTo ?? header("in-reply-to"),
    references: header("references"),
    attachments,
  };
}

export function stripServerPixelsFromHtml(html: string, publicUrl: string): string {
  let hostPath: string;
  try {
    const u = new URL(`${publicUrl.replace(/\/$/, "")}/p/`);
    hostPath = `${u.hostname}${u.pathname}`;
  } catch {
    hostPath = `${publicUrl.replace(/\/$/, "")}/p/`;
  }
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    if (/\bdata-omt\b/i.test(tag)) return "";
    if (tag.includes(hostPath)) return "";
    return tag;
  });
}

const DATA_IMG_SRC_RE = /(<img\b[^>]*\bsrc=)(["'])data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)\2/gi;
const GMAIL_DRAFT_IMG_SRC_RE = /(<img\b[^>]*\bsrc=)(["'])(https:\/\/mail\.google\.com\/mail\/[^"']*(?:view=fimg|view=att|disp=emb)[^"']*)\2/gi;

/** Converts pasted base64 data-URI images into proper CID inline attachments so recipients see them. */
export function extractDataUriImages(html: string): { html: string; inlineAttachments: MimeAttachment[] } {
  const inlineAttachments: MimeAttachment[] = [];
  let idx = 0;
  const rewritten = html.replace(DATA_IMG_SRC_RE, (_full, prefix: string, quote: string, contentType: string, b64: string) => {
    idx++;
    const cleanB64 = b64.replace(/\s+/g, "");
    const ext = contentType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "png";
    const digest = createHash("sha256").update(cleanB64).digest("hex").slice(0, 12);
    const cid = `omt-inline-${idx}-${digest}@open-mailtrack`;
    inlineAttachments.push({
      filename: `image-${idx}.${ext}`,
      contentType,
      contentBase64: cleanB64,
      cid,
      disposition: "inline",
    });
    return `${prefix}${quote}cid:${cid}${quote}`;
  });
  return { html: rewritten, inlineAttachments };
}

/** Counts private Gmail draft image URLs in editor HTML that must be mapped to draft CID attachments. */
export function countGmailDraftInlineImages(html: string): number {
  const matches = html.match(GMAIL_DRAFT_IMG_SRC_RE);
  return matches ? matches.length : 0;
}

/** Rewrites private Gmail draft image URLs to `cid:` references from the saved Gmail draft MIME. */
export function rewriteGmailDraftInlineImages(
  html: string,
  inlineAttachments: MimeAttachment[],
): { html: string; unresolved: number } {
  const cids = inlineAttachments.filter((a) => a.disposition === "inline" && a.cid).map((a) => a.cid!);
  let i = 0;
  let unresolved = 0;
  const rewritten = html.replace(GMAIL_DRAFT_IMG_SRC_RE, (full, prefix: string, quote: string) => {
    const cid = cids[i++];
    if (!cid) {
      unresolved++;
      return full;
    }
    return `${prefix}${quote}cid:${cid}${quote}`;
  });
  return { html: rewritten, unresolved };
}

export function injectPixelIntoHtml(html: string, pixelUrl: string): string {
  const pixel = `<img src="${pixelUrl}" width="1" height="1" alt="" style="border:0;width:1px;height:1px">`;
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${pixel}</body>`);
  }
  return `${html}${pixel}`;
}

export function htmlToPlainText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type CompileMimeInput = {
  from: string;
  to: string[];
  cc?: string[];
  /** Only set when compiling the clean Sent/Draft copy; never set on recipient SMTP copies. */
  includeBccHeader?: string[];
  subject: string;
  html: string;
  text?: string;
  inReplyTo?: string;
  references?: string;
  messageId: string;
  date?: Date;
  attachments?: MimeAttachment[];
};

export async function compileMime(input: CompileMimeInput): Promise<Buffer> {
  const mail = new MailComposer({
    from: input.from,
    to: input.to.length ? input.to.join(", ") : undefined,
    cc: input.cc && input.cc.length ? input.cc.join(", ") : undefined,
    bcc: input.includeBccHeader && input.includeBccHeader.length ? input.includeBccHeader.join(", ") : undefined,
    subject: input.subject,
    text: input.text ?? htmlToPlainText(input.html),
    html: input.html,
    inReplyTo: input.inReplyTo,
    references: input.references,
    messageId: input.messageId,
    date: input.date ?? new Date(),
    disableFileAccess: true,
    disableUrlAccess: true,
    attachments: (input.attachments ?? []).map((att) => ({
      filename: att.filename,
      contentType: att.contentType,
      content: Buffer.from(att.contentBase64, "base64"),
      cid: att.cid,
      contentDisposition: att.disposition ?? "attachment",
    })),
  });

  return await new Promise<Buffer>((resolve, reject) => {
    const compiled = mail.compile();
    if (input.includeBccHeader && input.includeBccHeader.length > 0) {
      compiled.keepBcc = true;
    }
    compiled.build((err, message) => {
      if (err) reject(err);
      else resolve(message);
    });
  });
}

export function extractEmailAddress(addr: string): string {
  const trimmed = addr.trim();
  const angleMatch = /<([^<>@\s]+@[^<>@\s]+)>\s*$/.exec(trimmed);
  if (angleMatch) return angleMatch[1].trim().toLowerCase();
  if (/^[^<>@\s]+@[^<>@\s]+$/.test(trimmed)) return trimmed.toLowerCase();
  return "";
}
