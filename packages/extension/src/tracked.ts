import type { TrackedMessage } from "./api.js";
import { lateText } from "./marks.js";
import { ago } from "./time.js";

const DAY = 86_400_000;
const iconUrl = (opened: boolean) => chrome.runtime.getURL(opened ? "icons/opened.svg" : "icons/sent.svg");

export type Bucket = "follow_up" | "unopened" | "recent" | "replied" | "all";

export const BUCKETS: { key: Bucket; label: string; hint: string }[] = [
  { key: "follow_up", label: "Needs follow-up", hint: "Opened, no reply, and quiet for a while" },
  { key: "unopened", label: "Not opened", hint: "Sent a while ago and never opened" },
  { key: "recent", label: "Recent opens", hint: "Opened in the last 24 hours" },
  { key: "replied", label: "Replied", hint: "They wrote back" },
  { key: "all", label: "All", hint: "Everything tracked, most recently opened first" },
];

/** Puts a message in the buckets it belongs to. `quietDays` is how long silence must last before it needs attention. */
export function bucketsOf(m: TrackedMessage, quietDays: number, now = Date.now()): Bucket[] {
  const quiet = quietDays * DAY;
  const sentAt = m.sent_at ?? m.created_at;
  const out: Bucket[] = ["all"];
  if (m.replied_at !== null) {
    out.push("replied");
    return out;
  }
  if (m.opens > 0 && now - m.lastOpenAt! <= DAY) out.push("recent");
  if (m.opens > 0 && now - m.lastOpenAt! >= quiet) out.push("follow_up");
  if (m.opens === 0 && now - sentAt >= quiet) out.push("unopened");
  return out;
}

export function rowText(m: TrackedMessage, now = Date.now()): string {
  if (m.replied_at !== null) return `Replied ${ago(m.replied_at, now)}`;
  if (m.opens === 0) return `Sent ${ago(m.sent_at ?? m.created_at, now)} · not opened`;
  const opens = m.opens === 1 ? "Opened" : `Opened ${m.opens} times, last`;
  return `${opens} ${ago(m.lastOpenAt!, now)}`;
}

export type TrackedState = { bucket: Bucket; quietDays: number };

export function trackedPage(
  doc: Document,
  messages: TrackedMessage[],
  state: TrackedState,
  onState: (next: TrackedState) => void,
  onOpen: (gmailThreadId: string) => void,
  now = Date.now(),
): HTMLElement {
  const root = doc.createElement("div");
  root.className = "omt-tracked";

  const counts = Object.fromEntries(BUCKETS.map((b) => [b.key, 0])) as Record<Bucket, number>;
  const bucketed = messages.map((m) => {
    const bs = bucketsOf(m, state.quietDays, now);
    for (const b of bs) counts[b]++;
    return { m, bs };
  });

  const bar = doc.createElement("div");
  bar.className = "omt-chips";
  bar.setAttribute("role", "tablist");
  for (const b of BUCKETS) {
    const chip = doc.createElement("button");
    chip.type = "button";
    chip.className = `omt-chip${b.key === state.bucket ? " omt-chip-active" : ""}`;
    chip.setAttribute("role", "tab");
    chip.setAttribute("aria-selected", String(b.key === state.bucket));
    chip.title = b.hint;
    chip.append(b.label);
    const n = doc.createElement("span");
    n.className = "omt-chip-count";
    n.textContent = String(counts[b.key]);
    chip.append(n);
    chip.addEventListener("click", () => onState({ ...state, bucket: b.key }));
    bar.append(chip);
  }

  const quiet = doc.createElement("label");
  quiet.className = "omt-quiet";
  quiet.append("quiet for ");
  const days = doc.createElement("input");
  days.type = "number";
  days.min = "1";
  days.max = "60";
  days.value = String(state.quietDays);
  days.setAttribute("aria-label", "Days of silence before a message needs attention");
  days.addEventListener("change", () => {
    const v = Math.min(60, Math.max(1, Number(days.value) || 1));
    onState({ ...state, quietDays: v });
  });
  quiet.append(days, " days");
  bar.append(quiet);
  root.append(bar);

  const visible = bucketed.filter(({ bs }) => bs.includes(state.bucket)).map(({ m }) => m);
  if (state.bucket === "unopened") visible.sort((a, b) => (a.sent_at ?? a.created_at) - (b.sent_at ?? b.created_at));
  if (state.bucket === "follow_up") visible.sort((a, b) => a.lastOpenAt! - b.lastOpenAt!);
  if (state.bucket === "replied") visible.sort((a, b) => b.replied_at! - a.replied_at!);

  if (visible.length === 0) {
    const empty = doc.createElement("p");
    empty.className = "omt-tracked-empty";
    empty.textContent =
      messages.length === 0 ? "No tracked messages yet. Send one from Gmail or with openmt." : "Nothing here right now.";
    root.append(empty);
    return root;
  }

  const list = doc.createElement("div");
  list.className = "omt-tracked-list";
  list.setAttribute("role", "list");
  for (const m of visible) {
    const row = doc.createElement(m.gmail_thread_id ? "a" : "div");
    row.className = `omt-tracked-row${m.opens > 0 ? " omt-tracked-opened" : ""}${m.replied_at !== null ? " omt-tracked-replied" : ""}`;
    row.setAttribute("role", "listitem");
    if (m.gmail_thread_id && row instanceof HTMLAnchorElement) {
      row.href = "#";
      const threadId = m.gmail_thread_id;
      row.addEventListener("click", (e) => {
        e.preventDefault();
        onOpen(threadId);
      });
    }

    const img = doc.createElement("img");
    img.src = iconUrl(m.opens > 0);
    img.alt = m.opens > 0 ? "Opened" : "Not opened";

    const to = doc.createElement("span");
    to.className = "omt-tracked-to";
    to.textContent = m.recipients.map((r) => r.split("@")[0]).join(", ");
    to.title = m.recipients.join(", ");

    const subject = doc.createElement("span");
    subject.className = "omt-tracked-subject";
    subject.textContent = m.subject || "(no subject)";

    const status = doc.createElement("span");
    status.className = "omt-tracked-status";
    status.textContent = rowText(m, now);

    row.append(img, to, subject);
    const late = lateText(m.late);
    if (late && m.replied_at === null) {
      const badge = doc.createElement("span");
      badge.className = "omt-status-late";
      badge.textContent = late;
      row.append(badge);
    }
    row.append(status);
    list.append(row);
  }
  root.append(list);
  return root;
}
