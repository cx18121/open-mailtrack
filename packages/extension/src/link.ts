import type { TrackedMessage } from "./api.js";

/** Search is a fallback, not proof of a match. Only a message's own pixel can restore its IDs. */
export function messageSearch(message: TrackedMessage): string {
  const quote = (value: string) => `"${value.replace(/["\\\r\n]/g, " ")}"`;
  const sent = message.sent_at ?? message.created_at;
  const day = (time: number) => new Date(time).toISOString().slice(0, 10).replaceAll("-", "/");
  return [
    "in:sent",
    message.recipients[0] ? `to:${quote(message.recipients[0])}` : "",
    message.subject ? `subject:${quote(message.subject)}` : "",
    `after:${day(sent - 86_400_000)}`,
    `before:${day(sent + 2 * 86_400_000)}`,
  ].filter(Boolean).join(" ");
}

/** Ignore quoted pixels and ambiguous bodies so replies cannot claim another message's tracking. */
export function ownPixelId(body: HTMLElement, serverUrl: string, isQuoted: (image: HTMLImageElement) => boolean): string | null {
  const base = `${serverUrl.replace(/\/$/, "")}/p/`;
  const ids = new Set<string>();
  for (const image of body.querySelectorAll("img")) {
    if (isQuoted(image) || image.closest(".gmail_quote, .gmail_quote_container")) continue;
    let url: URL;
    try {
      url = new URL(image.src);
      if (url.protocol === "https:" && /^[a-z0-9-]+\.googleusercontent\.com$/.test(url.hostname)) {
        url = new URL(url.hash.slice(1));
      }
    } catch {
      continue;
    }
    if (!url.href.startsWith(base)) continue;
    const match = /^([A-Za-z0-9_-]{22})\.gif$/.exec(url.href.slice(base.length));
    if (match) ids.add(match[1]);
  }
  return ids.size === 1 ? [...ids][0] : null;
}
