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

export type OpenSummary = { opens: number; firstOpenAt: number | null; lastOpenAt: number | null };

export function summarize(hits: ClassifiedHit[]): OpenSummary {
  const opens: number[] = [];
  for (const h of hits.filter((h) => h.kind === "open").sort((a, b) => a.at - b.at)) {
    if (opens.length === 0 || h.at - opens[opens.length - 1] > DEDUPE_MS) opens.push(h.at);
  }
  return { opens: opens.length, firstOpenAt: opens[0] ?? null, lastOpenAt: opens.at(-1) ?? null };
}
