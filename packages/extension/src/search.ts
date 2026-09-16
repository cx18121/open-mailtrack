import type { TrackedMessage } from "./api.js";

export const OPERATORS = ["has:opened", "has:unopened", "has:reply", "has:noreply"] as const;
export type Operator = (typeof OPERATORS)[number];

const matches: Record<Operator, (m: TrackedMessage) => boolean> = {
  "has:opened": (m) => m.opens > 0,
  "has:unopened": (m) => m.opens === 0,
  "has:reply": (m) => m.replied_at !== null,
  "has:noreply": (m) => m.replied_at === null,
};

/**
 * Gmail has no operator for "threads the server knows about", so each custom term expands to an OR of
 * Gmail's `thread:` operator over the matching thread ids. Gmail rejects an empty group, so an
 * operator with no matches expands to a query that can never match.
 */
export function expandOperator(op: Operator, messages: TrackedMessage[]): string {
  const ids = [...new Set(messages.filter(matches[op]).map((m) => m.gmail_thread_id).filter((id): id is string => !!id))];
  if (ids.length === 0) return "thread:0";
  return `{${ids.map((id) => `thread:${id}`).join(" ")}}`;
}
