import type { TrackedMessage } from "./api.js";

export const OPERATORS = ["has:opened", "has:unopened"] as const;
export type Operator = (typeof OPERATORS)[number];

/**
 * Gmail has no operator for "threads the server knows about", so each custom term expands to an OR of
 * Gmail's `thread:` operator over the matching thread ids. An operator with no matches expands to a
 * query that can never match, since Gmail rejects an empty group.
 */
export function expandOperator(op: Operator, messages: TrackedMessage[]): string {
  const wanted = op === "has:opened" ? (m: TrackedMessage) => m.opens > 0 : (m: TrackedMessage) => m.opens === 0;
  const ids = [...new Set(messages.filter(wanted).map((m) => m.gmail_thread_id).filter((id): id is string => !!id))];
  return ids.length ? `{${ids.map((id) => `thread:${id}`).join(" ")}}` : "thread:0";
}
