import type { OpenSummary, ThreadSummary } from "./api.js";
import { ago, clock, day, when } from "./time.js";

const iconUrl = (opened: boolean) => chrome.runtime.getURL(opened ? "icons/opened.svg" : "icons/sent.svg");

export function summaryText(s: OpenSummary, now = Date.now()): string {
  if (s.opens === 0) return "Sent · not opened yet";
  if (s.opens === 1) return `Opened once · ${when(s.firstOpenAt!, now)}`;
  return `Opened ${s.opens} times · first ${when(s.firstOpenAt!, now)} · last ${when(s.lastOpenAt!, now)}`;
}

export function rowTooltip(t: ThreadSummary, now = Date.now()): string {
  if (t.opens === 0) return t.tracked === 1 ? "Sent · not opened yet" : `${t.tracked} tracked · none opened yet`;
  const opens = t.opens === 1 ? "Opened once" : `Opened ${t.opens} times`;
  return `${opens} · last ${ago(t.lastOpenAt!, now)}`;
}

export function rowImage(t: ThreadSummary) {
  return { imageUrl: iconUrl(t.opens > 0), tooltip: rowTooltip(t), orderHint: 0 };
}

/** The always-visible status line placed above a sent message's body. */
export function statusElement(doc: Document, s: OpenSummary, now = Date.now()): HTMLElement {
  const opened = s.opens > 0;
  const root = doc.createElement("div");
  root.className = `omt-status${opened ? " omt-status-opened" : ""}`;

  const line = doc.createElement("div");
  line.className = "omt-status-line";
  const img = doc.createElement("img");
  img.src = iconUrl(opened);
  img.alt = "";
  const text = doc.createElement("span");
  text.className = "omt-status-text";
  text.textContent = summaryText(s, now);
  line.append(img, text);
  root.append(line);

  if (s.opens > 1) {
    const list = doc.createElement("ul");
    list.className = "omt-status-list";
    list.hidden = true;
    for (const t of s.openAts) {
      const li = doc.createElement("li");
      const time = doc.createElement("time");
      time.dateTime = new Date(t).toISOString();
      time.textContent = clock(t);
      const d = doc.createElement("span");
      d.textContent = day(t, now);
      li.append(time, d);
      list.append(li);
    }
    const toggle = doc.createElement("button");
    toggle.type = "button";
    toggle.className = "omt-status-details";
    toggle.textContent = "▸ details";
    toggle.addEventListener("click", () => {
      list.hidden = !list.hidden;
      toggle.textContent = list.hidden ? "▸ details" : "▾ details";
    });
    line.append(toggle);
    root.append(list);
  }
  return root;
}
