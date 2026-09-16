import { parseArgs } from "node:util";
import { readConfig, type Config } from "./config.js";

type Late = { kind: "after_send" | "after_previous"; days: number } | null;
export type TrackedMessage = {
  id: string;
  subject: string;
  recipients: string[];
  source: string;
  sent_at: number | null;
  created_at: number;
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  replied_at: number | null;
  opens: number;
  firstOpenAt: number | null;
  lastOpenAt: number | null;
  openAts: number[];
  late: Late;
};

const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

/** "7d", "12h", "2w" → ms. */
export function parseDuration(s: string): number {
  const m = /^(\d+)([mhdw])$/.exec(s);
  if (!m) throw new Error(`--since expects a number followed by m, h, d, or w, got "${s}"`);
  return Number(m[1]) * UNITS[m[2]];
}

export function ago(t: number, now = Date.now()): string {
  const d = now - t;
  if (d < 3_600_000) return `${Math.max(1, Math.round(d / 60_000))}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}

export function formatTable(messages: TrackedMessage[], now = Date.now()): string {
  if (messages.length === 0) return "No tracked messages.";
  const rows = messages.map((m) => {
    const opened = m.opens === 0 ? "-" : m.opens === 1 ? `opened ${ago(m.lastOpenAt!, now)}` : `opened ${m.opens}x, last ${ago(m.lastOpenAt!, now)}`;
    const late = !m.late ? "" : m.late.kind === "after_send" ? `${m.late.days}d after send` : `reopened after ${m.late.days}d`;
    const replied = m.replied_at === null ? "" : `replied ${ago(m.replied_at, now)}`;
    return [m.recipients.join(","), m.subject, `sent ${ago(m.sent_at ?? m.created_at, now)}`, opened, replied || late];
  });
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd()).join("\n");
}

export async function fetchStatus(config: Config, sinceMs: number | null): Promise<TrackedMessage[]> {
  const q = new URLSearchParams({ limit: "500" });
  if (sinceMs !== null) q.set("since", String(Date.now() - sinceMs));
  const res = await fetch(`${config.serverUrl}/api/messages?${q}`, { headers: { authorization: `Bearer ${config.apiKey}` } });
  if (!res.ok) throw new Error(`Tracker /messages failed: HTTP ${res.status} ${await res.text()}`);
  return ((await res.json()) as { messages: TrackedMessage[] }).messages;
}

export async function status(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: false },
      since: { type: "string" },
      opened: { type: "boolean", default: false },
      unopened: { type: "boolean", default: false },
      replied: { type: "boolean", default: false },
      "no-reply": { type: "boolean", default: false },
    },
  });
  const config = readConfig();
  let messages = await fetchStatus(config, values.since ? parseDuration(values.since) : null);
  if (values.opened) messages = messages.filter((m) => m.opens > 0);
  if (values.unopened) messages = messages.filter((m) => m.opens === 0);
  if (values.replied) messages = messages.filter((m) => m.replied_at !== null);
  if (values["no-reply"]) messages = messages.filter((m) => m.replied_at === null);
  console.log(values.json ? JSON.stringify(messages, null, 2) : formatTable(messages));
}
