import type { OpenSummary, RecipientOpenSummary, ThreadSummary } from "./api.js";
import { ago, clock, day, when } from "./time.js";

const statusIconUrl = (opens: number, appleMpp = 0) =>
  chrome.runtime.getURL(opens > 0 ? "icons/opened.svg" : appleMpp > 0 ? "icons/apple-proxy.svg" : "icons/sent.svg");

/** Mirrors Gmail's own header pattern: "3:05 PM (1 hour ago)". */
const stamp = (t: number, now: number) => `${when(t, now)} (${ago(t, now)})`;
const shortName = (email: string) => email.split("@")[0] || email;

export function lateText(late: OpenSummary["late"]): string {
  if (!late) return "";
  return late.kind === "after_send" ? `${late.days} days after sending` : `reopened after ${late.days} days`;
}

export function summaryText(s: OpenSummary, now = Date.now()): { count: string; rest: string; late: string } {
  const late = lateText(s.late);
  const recs = s.recipientSummaries;
  if (recs && recs.length > 1) {
    const opened = recs.filter((r) => r.opens > 0);
    const mppOnly = recs.filter((r) => r.opens === 0 && (r.appleMpp ?? 0) > 0);
    if (opened.length > 0) {
      const count = opened.length === recs.length ? `Opened by all ${recs.length}` : `${opened.length} of ${recs.length} opened`;
      return { count, rest: s.lastOpenAt ? `· last ${stamp(s.lastOpenAt, now)}` : "", late };
    }
    if (mppOnly.length > 0) {
      return {
        count: "Apple Mail privacy proxy",
        rest: `· ${mppOnly.length} of ${recs.length} may have been opened`,
        late,
      };
    }
    return { count: "Not opened yet", rest: `(${recs.length} recipients)`, late };
  }

  if (s.opens === 0 && (s.appleMpp ?? 0) > 0) {
    const fetched = s.lastAppleMppAt ? ` · fetched ${stamp(s.lastAppleMppAt, now)}` : "";
    return { count: "Apple Mail privacy proxy", rest: `· may have been opened${fetched}`, late };
  }
  if (s.opens === 0) return { count: "Not opened yet", rest: "", late };
  if (s.opens === 1) return { count: "Opened", rest: stamp(s.firstOpenAt!, now), late };
  return { count: `Opened ${s.opens} times`, rest: `· last ${stamp(s.lastOpenAt!, now)}`, late };
}

export function rowTooltip(t: ThreadSummary, now = Date.now()): string {
  const late = lateText(t.late);
  if (t.opens === 0) {
    if ((t.appleMpp ?? 0) > 0) {
      const fetched = t.lastAppleMppAt ? ` ${ago(t.lastAppleMppAt, now)}` : "";
      return `Sent · Apple Mail privacy proxy${fetched} (may not be a human open)`;
    }
    return t.tracked === 1 ? "Sent · not opened yet" : `${t.tracked} tracked · none opened yet`;
  }
  if ((t.recipientCount ?? 0) > 1 && (t.openedRecipients ?? 0) > 0) {
    const who = (t.openedRecipientEmails ?? []).slice(0, 3).map(shortName).join(", ");
    const whoPart = who ? ` (${who})` : "";
    return `${t.openedRecipients} of ${t.recipientCount} opened${whoPart} · last ${ago(t.lastOpenAt!, now)}${late ? ` · ${late}` : ""}`;
  }
  const opens = t.opens === 1 ? "Opened once" : `Opened ${t.opens} times`;
  return `${opens} · last ${ago(t.lastOpenAt!, now)}${late ? ` · ${late}` : ""}`;
}

export function rowImage(t: ThreadSummary) {
  return { imageUrl: statusIconUrl(t.opens, t.appleMpp ?? 0), tooltip: rowTooltip(t), orderHint: 0 };
}

/** Each open's time, oldest first, as shown under "Show all" and in the Tracked tab. */
export function openList(
  doc: Document,
  openAts: number[],
  now = Date.now(),
  appleMppAts: number[] = [],
): HTMLUListElement {
  const list = doc.createElement("ul");
  list.className = "omt-status-list";
  const events: { at: number; kind: "open" | "apple_mpp" }[] = [
    ...openAts.map((at) => ({ at, kind: "open" as const })),
    ...appleMppAts.map((at) => ({ at, kind: "apple_mpp" as const })),
  ].sort((a, b) => a.at - b.at);

  for (const ev of events) {
    const li = doc.createElement("li");
    const time = doc.createElement("time");
    time.dateTime = new Date(ev.at).toISOString();
    time.textContent = clock(ev.at);
    const d = doc.createElement("span");
    d.textContent = day(ev.at, now);
    li.append(time, d);
    if (ev.kind === "apple_mpp") {
      const tag = doc.createElement("span");
      tag.className = "omt-status-mpp";
      tag.textContent = "Apple Mail privacy proxy";
      li.append(tag);
    }
    list.append(li);
  }
  return list;
}

export function recipientBreakdown(
  doc: Document,
  recipients: RecipientOpenSummary[],
  now = Date.now(),
  onContactClick?: (email: string) => void,
): HTMLUListElement {
  const list = doc.createElement("ul");
  list.className = "omt-recipient-list";
  for (const r of recipients) {
    const li = doc.createElement("li");
    li.className = "omt-recipient-row";

    const img = doc.createElement("img");
    img.src = statusIconUrl(r.opens, r.appleMpp ?? 0);
    img.alt = r.opens > 0 ? "Opened" : (r.appleMpp ?? 0) > 0 ? "Apple Mail privacy proxy" : "Not opened";

    const who = doc.createElement(onContactClick ? "button" : "span");
    if (who instanceof HTMLButtonElement) {
      who.type = "button";
      who.className = "omt-contact-link";
      who.addEventListener("click", (e) => {
        e.stopPropagation();
        onContactClick?.(r.recipient);
      });
    } else {
      who.className = "omt-recipient-name";
    }
    who.textContent = r.recipient;
    who.title = `View open history for ${r.recipient}`;

    const detail = doc.createElement("span");
    detail.className = "omt-recipient-detail";
    if (r.opens > 0) {
      detail.textContent =
        r.opens === 1
          ? `Opened ${stamp(r.firstOpenAt!, now)}`
          : `Opened ${r.opens} times · last ${stamp(r.lastOpenAt!, now)}`;
    } else if ((r.appleMpp ?? 0) > 0) {
      detail.classList.add("omt-status-mpp");
      detail.textContent = `Apple Mail privacy proxy · ${r.lastAppleMppAt ? stamp(r.lastAppleMppAt, now) : "may have been opened"}`;
    } else {
      detail.textContent = "Not opened yet";
    }

    li.append(img, who);
    if (r.kind !== "to") {
      const kind = doc.createElement("span");
      kind.className = "omt-recipient-kind";
      kind.textContent = r.kind.toUpperCase();
      li.append(kind);
    }
    li.append(detail);
    list.append(li);
  }
  return list;
}

/** Whether the open list is showing. Kept by the caller so a refreshed line keeps it. */
export type Expansion = { expanded: boolean; onToggle: (expanded: boolean) => void };
export type StatusOptions = { onContactClick?: (email: string) => void };

/** The always-visible status line placed above a sent message's body. */
export function statusElement(
  doc: Document,
  s: OpenSummary,
  now = Date.now(),
  expansion: Expansion = { expanded: false, onToggle: () => {} },
  opts: StatusOptions = {},
): HTMLElement {
  const opened = s.opens > 0;
  const appleMpp = s.appleMpp ?? 0;
  const root = doc.createElement("div");
  root.className = "omt-status";

  const line = doc.createElement("div");
  line.className = "omt-status-line";
  const img = doc.createElement("img");
  img.src = statusIconUrl(s.opens, appleMpp);
  img.alt = opened ? "Opened" : appleMpp > 0 ? "Apple Mail privacy proxy" : "Not opened";
  const text = summaryText(s, now);
  const count = doc.createElement("span");
  count.className = opened ? "omt-status-count" : appleMpp > 0 ? "omt-status-mpp" : "omt-status-count";
  count.textContent = text.count;
  line.append(img, count);
  if (text.rest) {
    const rest = doc.createElement("span");
    rest.textContent = text.rest;
    line.append(rest);
  }
  if (text.late) {
    const late = doc.createElement("span");
    late.className = "omt-status-late";
    late.textContent = text.late;
    line.append(late);
  }

  const recs = s.recipientSummaries;
  if (recs && recs.length === 1 && opts.onContactClick) {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "omt-contact-link";
    btn.textContent = recs[0].recipient;
    btn.title = `View open history for ${recs[0].recipient}`;
    btn.addEventListener("click", () => opts.onContactClick!(recs[0].recipient));
    line.append(btn);
  }

  root.append(line);

  if (recs && recs.length > 1) {
    const breakdown = recipientBreakdown(doc, recs, now, opts.onContactClick);
    const toggle = doc.createElement("button");
    toggle.type = "button";
    toggle.className = "omt-status-toggle";
    const show = (expanded: boolean) => {
      breakdown.hidden = !expanded;
      toggle.textContent = expanded ? "Hide" : "Show recipients";
      toggle.setAttribute("aria-expanded", String(expanded));
    };
    show(expansion.expanded);
    toggle.addEventListener("click", () => {
      show(breakdown.hidden);
      expansion.onToggle(!breakdown.hidden);
    });
    line.append(toggle);
    root.append(breakdown);
  } else if (s.opens > 1 || (s.opens >= 1 && appleMpp > 0) || appleMpp > 1) {
    const list = openList(doc, s.openAts, now, s.appleMppAts ?? []);
    const toggle = doc.createElement("button");
    toggle.type = "button";
    toggle.className = "omt-status-toggle";
    const show = (expanded: boolean) => {
      list.hidden = !expanded;
      toggle.textContent = expanded ? "Hide" : "Show all";
      toggle.setAttribute("aria-expanded", String(expanded));
    };
    show(expansion.expanded);
    toggle.addEventListener("click", () => {
      show(list.hidden);
      expansion.onToggle(!list.hidden);
    });
    line.append(toggle);
    root.append(list);
  }
  return root;
}
