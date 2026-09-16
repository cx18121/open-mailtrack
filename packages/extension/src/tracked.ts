import type { TrackedMessage } from "./api.js";
import { lateText } from "./marks.js";
import { ago } from "./time.js";

const iconUrl = (opened: boolean) => chrome.runtime.getURL(opened ? "icons/opened.svg" : "icons/sent.svg");

export function rowText(m: TrackedMessage, now = Date.now()): string {
  if (m.opens === 0) return `Sent ${ago(m.sent_at ?? m.created_at, now)} · not opened`;
  const opens = m.opens === 1 ? "Opened" : `Opened ${m.opens} times, last`;
  return `${opens} ${ago(m.lastOpenAt!, now)}`;
}

/** The Tracked page: our own list in Gmail's visual language, sorted by the server (last open first). */
export function trackedList(
  doc: Document,
  messages: TrackedMessage[],
  onOpen: (gmailThreadId: string) => void,
  now = Date.now(),
): HTMLElement {
  const root = doc.createElement("div");
  root.className = "omt-tracked";

  if (messages.length === 0) {
    const empty = doc.createElement("p");
    empty.className = "omt-tracked-empty";
    empty.textContent = "No tracked messages yet. Send one from Gmail or with openmt.";
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
