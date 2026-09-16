import type { TrackedMessage } from "./api.js";
import { lateText } from "./marks.js";
import { ago } from "./time.js";

const iconUrl = (opened: boolean) => chrome.runtime.getURL(opened ? "icons/opened.svg" : "icons/sent.svg");

export function rowText(m: TrackedMessage, now = Date.now()): string {
  if (m.opens === 0) return `Sent ${ago(m.sent_at ?? m.created_at, now)} · not opened`;
  const opens = m.opens === 1 ? "Opened" : `Opened ${m.opens} times, last`;
  return `${opens} ${ago(m.lastOpenAt!, now)}`;
}

export type Filter = "all" | "opened" | "unopened";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "opened", label: "Opened" },
  { key: "unopened", label: "Not opened" },
];

/** The Tracked page: our own list in Gmail's visual language, sorted by the server (last open first). */
export function trackedList(
  doc: Document,
  all: TrackedMessage[],
  filter: Filter,
  onFilter: (next: Filter) => void,
  onOpen: (gmailThreadId: string) => void,
  now = Date.now(),
): HTMLElement {
  const root = doc.createElement("div");
  root.className = "omt-tracked";

  const bar = doc.createElement("div");
  bar.className = "omt-chips";
  bar.setAttribute("role", "tablist");
  for (const f of FILTERS) {
    const count = f.key === "all" ? all.length : all.filter((m) => (f.key === "opened") === m.opens > 0).length;
    const chip = doc.createElement("button");
    chip.type = "button";
    chip.className = `omt-chip${f.key === filter ? " omt-chip-active" : ""}`;
    chip.setAttribute("role", "tab");
    chip.setAttribute("aria-selected", String(f.key === filter));
    chip.append(f.label);
    const n = doc.createElement("span");
    n.className = "omt-chip-count";
    n.textContent = String(count);
    chip.append(n);
    chip.addEventListener("click", () => onFilter(f.key));
    bar.append(chip);
  }
  root.append(bar);

  const messages = filter === "all" ? all : all.filter((m) => (filter === "opened") === m.opens > 0);
  if (filter === "unopened") messages.sort((a, b) => (a.sent_at ?? a.created_at) - (b.sent_at ?? b.created_at));

  if (messages.length === 0) {
    const empty = doc.createElement("p");
    empty.className = "omt-tracked-empty";
    empty.textContent = all.length === 0 ? "No tracked messages yet. Send one from Gmail or with openmt." : "Nothing here right now.";
    root.append(empty);
    return root;
  }

  const list = doc.createElement("div");
  list.className = "omt-tracked-list";
  list.setAttribute("role", "list");
  for (const m of messages) {
    const row = doc.createElement(m.gmail_thread_id ? "a" : "div");
    row.className = `omt-tracked-row${m.opens > 0 ? " omt-tracked-opened" : ""}`;
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
    if (late) {
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
