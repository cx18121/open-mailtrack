export const CLASSIFIER_VERSION = 1;

export type HitKind = "open" | "self_view" | "prefetch";

export type ClassifiedHit = { at: number; kind: HitKind; reason: string };

const SELF_VIEW_BEFORE_MS = 5_000;
const SELF_VIEW_AFTER_MS = 15_000;
const DEDUPE_MS = 10_000;

/**
 * Rules come from the recorded matrix: Gmail and Workspace recipients fetch through
 * GoogleImageProxy with no delivery-time prefetch, the sender's own views land within
 * milliseconds of the extension's view signal, and a browser can fetch twice per render.
 */
export function classifyHit(hit: { at: number; user_agent: string | null }, selfViewsAt: number[]): ClassifiedHit {
  const nearView = selfViewsAt.find((v) => hit.at >= v - SELF_VIEW_BEFORE_MS && hit.at <= v + SELF_VIEW_AFTER_MS);
  if (nearView !== undefined) return { at: hit.at, kind: "self_view", reason: `sender viewed message at ${nearView}` };
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
