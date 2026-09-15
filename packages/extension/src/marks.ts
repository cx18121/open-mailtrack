import type { OpenSummary, ThreadSummary } from "./api.js";
import { ago, clock, day, when } from "./time.js";

const iconUrl = (opened: boolean) => chrome.runtime.getURL(opened ? "icons/opened.svg" : "icons/sent.svg");

/** Mirrors Gmail's own header pattern: "3:05 PM (1 hour ago)". */
const stamp = (t: number, now: number) => `${when(t, now)} (${ago(t, now)})`;

export function summaryText(s: OpenSummary, now = Date.now()): { count: string; rest: string } {
  if (s.opens === 0) return { count: "Not opened yet", rest: "" };
  if (s.opens === 1) return { count: "Opened", rest: stamp(s.firstOpenAt!, now) };
  return { count: `Opened ${s.opens} times`, rest: `· last ${stamp(s.lastOpenAt!, now)}` };
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
  root.className = "omt-status";

  const line = doc.createElement("div");
  line.className = "omt-status-line";
  const img = doc.createElement("img");
  img.src = iconUrl(opened);
  img.alt = opened ? "Opened" : "Not opened";
  const text = summaryText(s, now);
  const count = doc.createElement("span");
  count.className = "omt-status-count";
  count.textContent = text.count;
  line.append(img, count);
  if (text.rest) {
    const rest = doc.createElement("span");
    rest.textContent = text.rest;
    line.append(rest);
  }
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
    toggle.className = "omt-status-toggle";
    toggle.textContent = "Show all";
    toggle.setAttribute("aria-expanded", "false");
    toggle.addEventListener("click", () => {
      list.hidden = !list.hidden;
      toggle.textContent = list.hidden ? "Show all" : "Hide";
      toggle.setAttribute("aria-expanded", String(!list.hidden));
    });
    line.append(toggle);
    root.append(list);
  }
  return root;
}
