export const CLASSIFIER_VERSION = 5;

export type HitKind = "open" | "self_view" | "prefetch";

export type ClassifiedHit = { at: number; kind: HitKind; reason: string };

const SELF_VIEW_BEFORE_MS = 5_000;
const SELF_VIEW_AFTER_MS = 15_000;
const DEDUPE_MS = 10_000;
const SCAN_AFTER_SEND_MS = 30_000;
const SCAN_CLUSTER_MS = 2_000;
const GOOGLE_PROXY = /GoogleImageProxy/;
// Gmail's prefetch bot is distinct from the proxy used for recipient image loads.
// https://bird.com/en/resources/blog/gmail-prefetching-images
const GOOGLE_PREFETCH = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/42.0.2311.135 Safari/537.36 Edge/12.246 Mozilla/5.0";

export type ThreadContext = {
  /** Send times of every tracked message in the thread, this one included. */
  sentAts: number[];
  /** Hit times on the *other* tracked messages in the thread. */
  otherHitAts: number[];
};

/**
 * Sender views are correlated with the extension's view signal. Gmail's identifiable prefetch bot
 * is excluded regardless of timing. Recorded single-message threads also receive Google proxy
 * hits within half a second of sending, without a view signal. We conservatively exclude proxy
 * hits within 30 s of any send in the thread, accepting that a genuine immediate read may be missed.
 * Same-second refetches across tracked messages remain excluded up to 60 s after a send.
 * A browser can fetch twice per render.
 */
export function classifyHit(
  hit: { at: number; user_agent: string | null },
  selfViewsAt: number[],
  thread: ThreadContext = { sentAts: [], otherHitAts: [] },
): ClassifiedHit {
  const nearView = selfViewsAt.find((v) => hit.at >= v - SELF_VIEW_BEFORE_MS && hit.at <= v + SELF_VIEW_AFTER_MS);
  if (nearView !== undefined) return { at: hit.at, kind: "self_view", reason: `sender viewed message at ${nearView}` };
  if (hit.user_agent === GOOGLE_PREFETCH) return { at: hit.at, kind: "prefetch", reason: "known gmail prefetch bot" };
  if (GOOGLE_PROXY.test(hit.user_agent ?? "")) {
    const recentSend = thread.sentAts.find((t) => hit.at >= t && hit.at - t <= SCAN_AFTER_SEND_MS);
    if (recentSend !== undefined) {
      return { at: hit.at, kind: "prefetch", reason: `google proxy fetch ${Math.round((hit.at - recentSend) / 1000)}s after a send in this thread` };
    }
    const sibling = thread.otherHitAts.find((t) => Math.abs(t - hit.at) <= SCAN_CLUSTER_MS);
    const clusterSend = thread.sentAts.find((t) => hit.at >= t && hit.at - t <= 2 * SCAN_AFTER_SEND_MS);
    if (thread.sentAts.length > 1 && sibling !== undefined && clusterSend !== undefined) {
      return { at: hit.at, kind: "prefetch", reason: `thread-wide google proxy refetch ${Math.round((hit.at - clusterSend) / 1000)}s after a send into this thread` };
    }
  }
  return { at: hit.at, kind: "open", reason: "no exclusion matched" };
}

export type OpenSummary = {
  opens: number;
  firstOpenAt: number | null;
  lastOpenAt: number | null;
  openAts: number[];
  /** Set when the latest open came long after sending or long after the previous open. */
  late: { kind: "after_send" | "after_previous"; days: number } | null;
};

const LATE_MS = 2 * 24 * 3_600_000;

export function summarize(hits: ClassifiedHit[], sentAt: number | null = null): OpenSummary {
  const opens: number[] = [];
  for (const h of hits.filter((h) => h.kind === "open").sort((a, b) => a.at - b.at)) {
    if (opens.length === 0 || h.at - opens[opens.length - 1] > DEDUPE_MS) opens.push(h.at);
  }
  const last = opens.at(-1) ?? null;
  const previous = opens.at(-2) ?? null;
  const days = (ms: number) => Math.round(ms / 86_400_000);
  let late: OpenSummary["late"] = null;
  if (last !== null && previous !== null && last - previous >= LATE_MS) late = { kind: "after_previous", days: days(last - previous) };
  else if (last !== null && previous === null && sentAt !== null && last - sentAt >= LATE_MS) late = { kind: "after_send", days: days(last - sentAt) };
  return { opens: opens.length, firstOpenAt: opens[0] ?? null, lastOpenAt: last, openAts: opens, late };
}
