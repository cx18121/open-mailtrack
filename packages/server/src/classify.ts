export const CLASSIFIER_VERSION = 4;

export type HitKind = "open" | "self_view" | "prefetch";

export type ClassifiedHit = { at: number; kind: HitKind; reason: string };

const SELF_VIEW_BEFORE_MS = 5_000;
const SELF_VIEW_AFTER_MS = 15_000;
const DEDUPE_MS = 10_000;
const SCAN_AFTER_SEND_MS = 30_000;
const SCAN_CLUSTER_MS = 2_000;
const GOOGLE_PROXY = /GoogleImageProxy/;

export type ThreadContext = {
  /** Send times of every tracked message in the thread, this one included. */
  sentAts: number[];
  /** Hit times on the *other* tracked messages in the thread. */
  otherHitAts: number[];
};

/**
 * Rules come from recorded traffic. Gmail and Workspace recipients fetch through GoogleImageProxy.
 * The sender's own views land within milliseconds of the extension's view signal. When a reply lands
 * in a thread the recipient already viewed, Gmail refetches the images of every message in that
 * thread, about 17 s after the send, with nobody looking. Observed twice as a same-second cluster
 * across the thread and once as a lone fetch of the new reply only. Fresh single-message threads
 * showed no scan at all. So: within 30 s of a send into a thread that already had tracked mail, a
 * Google proxy hit is the scan, whether or not siblings were refetched; a cluster of hits across the
 * thread just after a send is the scan even outside that window. A browser can fetch twice per render.
 */
export function classifyHit(
  hit: { at: number; user_agent: string | null },
  selfViewsAt: number[],
  thread: ThreadContext = { sentAts: [], otherHitAts: [] },
): ClassifiedHit {
  const nearView = selfViewsAt.find((v) => hit.at >= v - SELF_VIEW_BEFORE_MS && hit.at <= v + SELF_VIEW_AFTER_MS);
  if (nearView !== undefined) return { at: hit.at, kind: "self_view", reason: `sender viewed message at ${nearView}` };
  if (GOOGLE_PROXY.test(hit.user_agent ?? "") && thread.sentAts.length > 1) {
    const recentSend = thread.sentAts.find((t) => hit.at >= t && hit.at - t <= SCAN_AFTER_SEND_MS);
    if (recentSend !== undefined) {
      return { at: hit.at, kind: "prefetch", reason: `google proxy refetch ${Math.round((hit.at - recentSend) / 1000)}s after a send into this thread` };
    }
    const sibling = thread.otherHitAts.find((t) => Math.abs(t - hit.at) <= SCAN_CLUSTER_MS);
    const clusterSend = thread.sentAts.find((t) => hit.at >= t && hit.at - t <= 2 * SCAN_AFTER_SEND_MS);
    if (sibling !== undefined && clusterSend !== undefined) {
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
