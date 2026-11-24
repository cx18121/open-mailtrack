export const CLASSIFIER_VERSION = 7;

export type HitKind = "open" | "self_view" | "prefetch" | "apple_mpp" | "bot" | "ignored" | "post_reply";

export type ClassifiedHit = { at: number; kind: HitKind; reason: string; client?: string | null };

export type OpenEvent = { at: number; client: string | null };

const SELF_VIEW_BEFORE_MS = 5_000;
const SELF_VIEW_AFTER_MS = 15_000;
const DEDUPE_MS = 10_000;
const SCAN_AFTER_SEND_MS = 30_000;
const YAHOO_SCAN_AFTER_SEND_MS = 10_000;
const SCAN_CLUSTER_MS = 2_000;
const GOOGLE_PROXY = /GoogleImageProxy/;
const YAHOO_PROXY = /YahooMailProxy/i;
const APPLE_MPP_UA = "Mozilla/5.0";
// Gmail's prefetch bot is distinct from the proxy used for recipient image loads.
// https://bird.com/en/resources/blog/gmail-prefetching-images
const GOOGLE_PREFETCH = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/42.0.2311.135 Safari/537.36 Edge/12.246 Mozilla/5.0";
const SECURITY_BOT_UA =
  /\b(Slackbot|Twitterbot|facebookexternalhit|WhatsApp|Discordbot|LinkedInBot|TelegramBot|BingPreview|HeadlessChrome|Proofpoint|Mimecast|Barracuda|Symantec|Trend\s*Micro|Sophos|UrlScan|SafeLinks|Microsoft Office Existence Discovery|curl|python-requests|Go-http-client|Wget|Scrapy|bot|spider|crawler)\b/i;

export type ThreadContext = {
  /** Send times of every tracked message in the thread, this one included. */
  sentAts: number[];
  /** Hit times on the *other* tracked messages in the thread. */
  otherHitAts: number[];
};

export type ClassifyOptions = {
  isAppleRelayIp?: (ip: string | null | undefined) => boolean;
  isIgnoredIp?: (ip: string | null | undefined) => boolean;
  /** Earliest reply timestamp from the recipient (or thread for single-recipient messages). */
  repliedAt?: number | null;
};

/** Honest human-readable client/device label derived from User-Agent and classification kind. */
export function describeClient(userAgent: string | null | undefined, kind?: HitKind): string | null {
  if (kind === "apple_mpp") return "Apple Mail (privacy proxy)";
  if (kind === "bot") return "Security scanner";
  if (!userAgent) return null;
  if (GOOGLE_PROXY.test(userAgent)) return "Gmail";
  if (YAHOO_PROXY.test(userAgent)) return "Yahoo Mail";
  if (/Outlook-iOS/i.test(userAgent)) return "Outlook (iOS)";
  if (/Outlook-Android/i.test(userAgent)) return "Outlook (Android)";
  if (/Outlook|MSOffice|Microsoft Office/i.test(userAgent)) return "Outlook";
  if (/Thunderbird/i.test(userAgent)) return "Thunderbird";
  if (/iPhone/i.test(userAgent)) return "iPhone";
  if (/iPad/i.test(userAgent)) return "iPad";
  if (/Android/i.test(userAgent)) return "Android";
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "macOS";
  if (/Windows/i.test(userAgent)) return "Windows";
  if (/Linux/i.test(userAgent)) return "Linux";
  return null;
}

/**
 * Classifies a pixel hit into a human open or one of several explicit non-open categories:
 * - `self_view`: correlated with the extension's view signal (legacy mode).
 * - `ignored`: source IP matches the user's configured ignore list (applies to direct non-proxied hits).
 * - `prefetch`: Gmail's known prefetch bot, or Google/Yahoo proxy fetches right after a send.
 * - `apple_mpp`: bare `Mozilla/5.0` from Apple's published Private Relay egress IP ranges.
 * - `bot`: known link/image previewers and corporate security scanners.
 * - `post_reply`: Google image-proxy fetch after the recipient already replied (prevents mobile Gmail
 *   views of quoted reply threads from inflating open counts).
 */
export function classifyHit(
  hit: { at: number; ip?: string | null; user_agent: string | null },
  selfViewsAt: number[],
  thread: ThreadContext = { sentAts: [], otherHitAts: [] },
  opts: ClassifyOptions = {},
): ClassifiedHit {
  const nearView = selfViewsAt.find((v) => hit.at >= v - SELF_VIEW_BEFORE_MS && hit.at <= v + SELF_VIEW_AFTER_MS);
  if (nearView !== undefined) {
    return { at: hit.at, kind: "self_view", reason: `sender viewed message at ${nearView}`, client: describeClient(hit.user_agent, "self_view") };
  }
  if (hit.user_agent === GOOGLE_PREFETCH) {
    return { at: hit.at, kind: "prefetch", reason: "known gmail prefetch bot", client: "Gmail prefetch" };
  }
  if (opts.isIgnoredIp?.(hit.ip)) {
    return { at: hit.at, kind: "ignored", reason: "source IP matches ignored IP list", client: describeClient(hit.user_agent, "ignored") };
  }
  if (hit.user_agent === APPLE_MPP_UA && opts.isAppleRelayIp?.(hit.ip)) {
    return { at: hit.at, kind: "apple_mpp", reason: "apple mail privacy protection proxy", client: "Apple Mail (privacy proxy)" };
  }
  if (hit.user_agent && SECURITY_BOT_UA.test(hit.user_agent)) {
    return { at: hit.at, kind: "bot", reason: "known bot or security scanner user agent", client: "Security scanner" };
  }
  if (GOOGLE_PROXY.test(hit.user_agent ?? "")) {
    const recentSend = thread.sentAts.find((t) => hit.at >= t && hit.at - t <= SCAN_AFTER_SEND_MS);
    if (recentSend !== undefined) {
      return {
        at: hit.at,
        kind: "prefetch",
        reason: `google proxy fetch ${Math.round((hit.at - recentSend) / 1000)}s after a send in this thread`,
        client: "Gmail",
      };
    }
    const sibling = thread.otherHitAts.find((t) => Math.abs(t - hit.at) <= SCAN_CLUSTER_MS);
    const clusterSend = thread.sentAts.find((t) => hit.at >= t && hit.at - t <= 2 * SCAN_AFTER_SEND_MS);
    if (thread.sentAts.length > 1 && sibling !== undefined && clusterSend !== undefined) {
      return {
        at: hit.at,
        kind: "prefetch",
        reason: `thread-wide google proxy refetch ${Math.round((hit.at - clusterSend) / 1000)}s after a send into this thread`,
        client: "Gmail",
      };
    }
    if (opts.repliedAt != null && hit.at >= opts.repliedAt) {
      return {
        at: hit.at,
        kind: "post_reply",
        reason: "google proxy fetch after recipient replied (likely quoted pixel)",
        client: "Gmail",
      };
    }
  }
  if (YAHOO_PROXY.test(hit.user_agent ?? "")) {
    const recentSend = thread.sentAts.find((t) => hit.at >= t && hit.at - t <= YAHOO_SCAN_AFTER_SEND_MS);
    if (recentSend !== undefined) {
      return {
        at: hit.at,
        kind: "prefetch",
        reason: `yahoo proxy fetch ${Math.round((hit.at - recentSend) / 1000)}s after send`,
        client: "Yahoo Mail",
      };
    }
  }
  return { at: hit.at, kind: "open", reason: "no exclusion matched", client: describeClient(hit.user_agent, "open") };
}

export type OpenSummary = {
  opens: number;
  firstOpenAt: number | null;
  lastOpenAt: number | null;
  openAts: number[];
  /** Set when the latest open came long after sending or long after the previous open. */
  late: { kind: "after_send" | "after_previous"; days: number } | null;
  appleMpp: number;
  firstAppleMppAt: number | null;
  lastAppleMppAt: number | null;
  appleMppAts: number[];
};

export type RecipientOpenSummary = OpenSummary & {
  recipient: string;
  kind: "to" | "cc" | "bcc";
};

const LATE_MS = 2 * 24 * 3_600_000;

function dedupeTimes(times: number[]): number[] {
  const out: number[] = [];
  for (const t of [...times].sort((a, b) => a - b)) {
    if (out.length === 0 || t - out[out.length - 1] > DEDUPE_MS) out.push(t);
  }
  return out;
}

/** Deduplicated open events with client hints, aligned 1-to-1 with `summarize().openAts`. */
export function extractOpenEvents(hits: ClassifiedHit[]): OpenEvent[] {
  const opens = hits.filter((h) => h.kind === "open").sort((a, b) => a.at - b.at);
  const out: OpenEvent[] = [];
  for (const h of opens) {
    if (out.length === 0 || h.at - out[out.length - 1].at > DEDUPE_MS) {
      out.push({ at: h.at, client: h.client ?? null });
    }
  }
  return out;
}

export function summarize(hits: ClassifiedHit[], sentAt: number | null = null): OpenSummary {
  const opens = dedupeTimes(hits.filter((h) => h.kind === "open").map((h) => h.at));
  const appleMppAts = dedupeTimes(hits.filter((h) => h.kind === "apple_mpp").map((h) => h.at));
  const last = opens.at(-1) ?? null;
  const previous = opens.at(-2) ?? null;
  const days = (ms: number) => Math.round(ms / 86_400_000);
  let late: OpenSummary["late"] = null;
  if (last !== null && previous !== null && last - previous >= LATE_MS) late = { kind: "after_previous", days: days(last - previous) };
  else if (last !== null && previous === null && sentAt !== null && last - sentAt >= LATE_MS) late = { kind: "after_send", days: days(last - sentAt) };
  return {
    opens: opens.length,
    firstOpenAt: opens[0] ?? null,
    lastOpenAt: last,
    openAts: opens,
    late,
    appleMpp: appleMppAts.length,
    firstAppleMppAt: appleMppAts[0] ?? null,
    lastAppleMppAt: appleMppAts.at(-1) ?? null,
    appleMppAts,
  };
}
