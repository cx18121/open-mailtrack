export const CLASSIFIER_VERSION = 3;

export type HitKind = "open" | "self_view" | "prefetch";

export type ClassifiedHit = { at: number; kind: HitKind; reason: string };

const SELF_VIEW_BEFORE_MS = 5_000;
const SELF_VIEW_AFTER_MS = 15_000;
const DEDUPE_MS = 10_000;
const DELIVERY_SCAN_MS = 30_000;
const GOOGLE_PROXY = /GoogleImageProxy/;

/**
 * Rules come from recorded traffic. Gmail and Workspace recipients fetch through GoogleImageProxy.
 * The sender's own views land within milliseconds of the extension's view signal. When a reply lands
 * in a thread the recipient already viewed, Gmail fetches the images of every message in that thread
 * about 17 s after send with nobody looking; new threads showed no such fetch. A browser can fetch
 * twice per render.
 *
 * `threadSentAts` are the send times of every tracked message in the same thread, this one included.
 */
export function classifyHit(
  hit: { at: number; user_agent: string | null },
  selfViewsAt: number[],
  threadSentAts: number[] = [],
): ClassifiedHit {
  const nearView = selfViewsAt.find((v) => hit.at >= v - SELF_VIEW_BEFORE_MS && hit.at <= v + SELF_VIEW_AFTER_MS);
  if (nearView !== undefined) return { at: hit.at, kind: "self_view", reason: `sender viewed message at ${nearView}` };
  const recentSend = threadSentAts.find((t) => hit.at >= t && hit.at - t <= DELIVERY_SCAN_MS);
  if (recentSend !== undefined && GOOGLE_PROXY.test(hit.user_agent ?? "")) {
    return { at: hit.at, kind: "prefetch", reason: `google proxy fetch ${Math.round((hit.at - recentSend) / 1000)}s after a send in this thread` };
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
