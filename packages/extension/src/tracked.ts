import type { ContactMessageEntry, ContactSummary, OutboxItem, TrackedMessage } from "./api.js";
import { messageSearch } from "./link.js";
import { lateText, openList, recipientBreakdown } from "./marks.js";
import { ago, when } from "./time.js";

const statusIconUrl = (opens: number, appleMpp = 0) =>
  chrome.runtime.getURL(opens > 0 ? "icons/opened.svg" : appleMpp > 0 ? "icons/apple-proxy.svg" : "icons/sent.svg");

export function rowText(m: TrackedMessage, now = Date.now()): string {
  const recs = m.recipientSummaries;
  if (recs && recs.length > 1) {
    const opened = recs.filter((r) => r.opens > 0).length;
    const mpp = recs.filter((r) => r.opens === 0 && (r.appleMpp ?? 0) > 0).length;
    if (opened > 0) return `${opened} of ${recs.length} opened, last ${ago(m.lastOpenAt!, now)}`;
    if (mpp > 0) return `Apple Mail proxy (${mpp} of ${recs.length})`;
    return `Sent ${ago(m.sent_at ?? m.created_at, now)} · not opened`;
  }
  if (m.opens === 0 && (m.appleMpp ?? 0) > 0) {
    return `Apple Mail proxy ${m.lastAppleMppAt ? ago(m.lastAppleMppAt, now) : ""}`.trim();
  }
  if (m.opens === 0) return `Sent ${ago(m.sent_at ?? m.created_at, now)} · not opened`;
  const opens = m.opens === 1 ? "Opened" : `Opened ${m.opens} times, last`;
  return `${opens} ${ago(m.lastOpenAt!, now)}`;
}

export type Section = "messages" | "scheduled" | "contacts";
export type Filter = "all" | "opened" | "unopened" | "followup";
const FOLLOWUP_MIN_AGE_MS = 24 * 3_600_000;
const FOLLOWUP_MAX_AGE_MS = 30 * 86_400_000;

export function needsFollowup(m: TrackedMessage, now = Date.now()): boolean {
  if (m.replied_at || m.followup_dismissed_at) return false;
  const age = now - (m.sent_at ?? m.created_at);
  return age >= FOLLOWUP_MIN_AGE_MS && age <= FOLLOWUP_MAX_AGE_MS;
}

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "opened", label: "Opened" },
  { key: "unopened", label: "Not opened" },
  { key: "followup", label: "Needs follow-up" },
];

export type ListState = {
  filter: Filter;
  /** IDs of messages whose open times or recipients are showing. Kept by the caller so refreshes keep them open. */
  expanded: ReadonlySet<string>;
  onFilter: (next: Filter) => void;
  onOpen: (message: TrackedMessage) => void;
  onToggle: (id: string) => void;
  onContactClick?: (email: string) => void;
  onDismissFollowup?: (id: string) => void;
  onCheckReplies?: () => void;
};

export function sectionBar(
  doc: Document,
  active: Section,
  counts: { messages: number; scheduled: number; contacts: number },
  onSection: (next: Section) => void,
): HTMLElement {
  const nav = doc.createElement("div");
  nav.className = "omt-tabs";
  nav.setAttribute("role", "tablist");
  const tabs: { key: Section; label: string; count: number }[] = [
    { key: "messages", label: "Messages", count: counts.messages },
    { key: "scheduled", label: "Scheduled", count: counts.scheduled },
    { key: "contacts", label: "Contacts", count: counts.contacts },
  ];
  for (const t of tabs) {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = `omt-tab${t.key === active ? " omt-tab-active" : ""}`;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", String(t.key === active));
    btn.dataset.omtFocus = `tab:${t.key}`;
    btn.append(t.label);
    const badge = doc.createElement("span");
    badge.className = "omt-chip-count";
    badge.textContent = String(t.count);
    btn.append(badge);
    btn.addEventListener("click", () => onSection(t.key));
    nav.append(btn);
  }
  return nav;
}

/** The Tracked Messages list in Gmail's visual language, sorted by the server (last open first). */
export function trackedList(
  doc: Document,
  all: TrackedMessage[],
  { filter, expanded, onFilter, onOpen, onToggle, onContactClick, onDismissFollowup, onCheckReplies }: ListState,
  now = Date.now(),
): HTMLElement {
  const root = doc.createElement("div");
  root.className = "omt-tracked";

  const bar = doc.createElement("div");
  bar.className = "omt-chips";
  bar.setAttribute("role", "tablist");
  for (const f of FILTERS) {
    const count =
      f.key === "all"
        ? all.length
        : f.key === "followup"
          ? all.filter((m) => needsFollowup(m, now)).length
          : all.filter((m) => (f.key === "opened") === m.opens > 0).length;
    const chip = doc.createElement("button");
    chip.type = "button";
    chip.className = `omt-chip${f.key === filter ? " omt-chip-active" : ""}`;
    chip.setAttribute("role", "tab");
    chip.dataset.omtFocus = `chip:${f.key}`;
    chip.setAttribute("aria-selected", String(f.key === filter));
    chip.append(f.label);
    const n = doc.createElement("span");
    n.className = "omt-chip-count";
    n.textContent = String(count);
    chip.append(n);
    chip.addEventListener("click", () => onFilter(f.key));
    bar.append(chip);
  }
  if (filter === "followup" && onCheckReplies) {
    const refresh = doc.createElement("button");
    refresh.type = "button";
    refresh.className = "omt-btn omt-followup-refresh";
    refresh.textContent = "Check replies";
    refresh.addEventListener("click", () => onCheckReplies());
    bar.append(refresh);
  }
  root.append(bar);

  const messages =
    filter === "all"
      ? [...all]
      : filter === "followup"
        ? all.filter((m) => needsFollowup(m, now))
        : all.filter((m) => (filter === "opened") === m.opens > 0);
  if (filter === "unopened") {
    messages.sort((a, b) => (a.sent_at ?? a.created_at) - (b.sent_at ?? b.created_at));
  } else if (filter === "followup") {
    // Show opened-without-reply leads first (most recently opened), then unopened oldest first.
    messages.sort((a, b) => {
      const aOpened = a.opens > 0 ? 1 : 0;
      const bOpened = b.opens > 0 ? 1 : 0;
      if (aOpened !== bOpened) return bOpened - aOpened;
      if (aOpened) return (b.lastOpenAt ?? 0) - (a.lastOpenAt ?? 0);
      return (a.sent_at ?? a.created_at) - (b.sent_at ?? b.created_at);
    });
  }

  if (messages.length === 0) {
    const empty = doc.createElement("p");
    empty.className = "omt-tracked-empty";
    empty.textContent =
      all.length === 0
        ? "No tracked messages yet. Send one from Gmail or with openmt."
        : filter === "followup"
          ? "No emails waiting for a reply right now."
          : "Nothing here right now.";
    root.append(empty);
    return root;
  }

  const list = doc.createElement("div");
  list.className = "omt-tracked-list";
  list.setAttribute("role", "list");
  for (const m of messages) {
    const item = doc.createElement("div");
    const mppOnly = m.opens === 0 && (m.appleMpp ?? 0) > 0;
    item.className = `omt-tracked-item${m.opens > 0 ? " omt-tracked-opened" : mppOnly ? " omt-tracked-mpp" : ""}`;
    item.setAttribute("role", "listitem");
    const head = doc.createElement("div");
    head.className = "omt-tracked-head";
    item.append(head);

    const row = doc.createElement("a");
    row.className = "omt-tracked-row";
    row.dataset.omtFocus = `row:${m.id}`;
    row.href = m.gmail_thread_id ? `#all/${encodeURIComponent(m.gmail_thread_id)}` : `#search/${encodeURIComponent(messageSearch(m))}`;
    if (!m.gmail_thread_id) row.title = "Find this sent message in Gmail to restore its tracking marks";
    row.addEventListener("click", (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      onOpen(m);
    });

    const img = doc.createElement("img");
    img.src = statusIconUrl(m.opens, m.appleMpp ?? 0);
    img.alt = m.opens > 0 ? "Opened" : mppOnly ? "Apple Mail privacy proxy" : "Not opened";

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
    if (m.replied_at) {
      const pill = doc.createElement("span");
      pill.className = "omt-replied-pill";
      pill.textContent = "Replied";
      row.append(pill);
    }
    const late = lateText(m.late);
    if (late) {
      const badge = doc.createElement("span");
      badge.className = "omt-status-late";
      badge.textContent = late;
      row.append(badge);
    }
    row.append(status);
    head.append(row);

    if (filter === "followup" && onDismissFollowup) {
      const dismiss = doc.createElement("button");
      dismiss.type = "button";
      dismiss.className = "omt-btn omt-dismiss-btn";
      dismiss.textContent = "Dismiss";
      dismiss.title = "Dismiss from Needs follow-up";
      dismiss.addEventListener("click", (e) => {
        e.stopPropagation();
        onDismissFollowup(m.id);
      });
      head.append(dismiss);
    }

    const hasDetails =
      m.opens > 0 || (m.appleMpp ?? 0) > 0 || (m.recipientSummaries !== undefined && m.recipientSummaries.length > 1);
    if (hasDetails) {
      const open = expanded.has(m.id);
      const toggle = doc.createElement("button");
      toggle.type = "button";
      toggle.className = "omt-tracked-toggle";
      toggle.dataset.omtFocus = `toggle:${m.id}`;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", `${open ? "Hide" : "Show"} details for ${m.subject || "(no subject)"}`);
      toggle.title = open ? "Hide details" : "Show details";
      toggle.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z" fill="currentColor"/></svg>';
      toggle.addEventListener("click", () => onToggle(m.id));
      head.append(toggle);
      if (open) {
        if (m.recipientSummaries && m.recipientSummaries.length > 1) {
          const breakdown = recipientBreakdown(doc, m.recipientSummaries, now, onContactClick);
          breakdown.classList.add("omt-tracked-opens");
          item.append(breakdown);
        } else {
          const times = openList(doc, m.openAts, now, m.appleMppAts ?? []);
          times.classList.add("omt-tracked-opens");
          item.append(times);
        }
      }
    } else {
      const spacer = doc.createElement("span");
      spacer.className = "omt-tracked-toggle-space";
      head.append(spacer);
    }
    list.append(item);
  }
  root.append(list);
  return root;
}

export type ScheduledState = {
  onSendNow: (item: OutboxItem) => void;
  onReschedule: (item: OutboxItem, sendAt: number) => void;
  onCancel: (item: OutboxItem) => void;
};

function toLocalDatetimeValue(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function scheduledList(doc: Document, items: OutboxItem[], actions: ScheduledState, now = Date.now()): HTMLElement {
  const root = doc.createElement("div");
  root.className = "omt-tracked";
  if (items.length === 0) {
    const empty = doc.createElement("p");
    empty.className = "omt-tracked-empty";
    empty.textContent = "No scheduled or pending messages.";
    root.append(empty);
    return root;
  }

  const list = doc.createElement("div");
  list.className = "omt-tracked-list";
  for (const item of items) {
    const row = doc.createElement("div");
    row.className = "omt-scheduled-item";
    const top = doc.createElement("div");
    top.className = "omt-scheduled-head";

    const allRecs = [...item.recipients.to, ...item.recipients.cc, ...item.recipients.bcc];
    const to = doc.createElement("span");
    to.className = "omt-tracked-to";
    to.textContent = allRecs.map((r) => r.split("@")[0]).join(", ");
    to.title = allRecs.join(", ");

    const subject = doc.createElement("span");
    subject.className = "omt-tracked-subject";
    subject.textContent = item.subject || "(no subject)";

    const whenEl = doc.createElement("span");
    whenEl.className = item.status === "failed" ? "omt-scheduled-error" : "omt-tracked-status";
    whenEl.textContent =
      item.status === "failed"
        ? `Failed: ${item.error || "send error"}`
        : item.status === "sending"
          ? "Sending…"
          : `Scheduled for ${when(item.sendAt, now)}`;

    const btns = doc.createElement("div");
    btns.className = "omt-scheduled-actions";

    if (item.status !== "sending") {
      const sendNow = doc.createElement("button");
      sendNow.type = "button";
      sendNow.className = "omt-btn";
      sendNow.textContent = item.status === "failed" ? "Retry now" : "Send now";
      sendNow.addEventListener("click", () => actions.onSendNow(item));

      const picker = doc.createElement("input");
      picker.type = "datetime-local";
      picker.className = "omt-datetime";
      picker.value = toLocalDatetimeValue(Math.max(item.sendAt, now + 60_000));
      picker.title = "Reschedule send time";
      picker.addEventListener("change", () => {
        const next = new Date(picker.value).getTime();
        if (Number.isFinite(next) && next > Date.now()) actions.onReschedule(item, next);
      });

      const cancel = doc.createElement("button");
      cancel.type = "button";
      cancel.className = "omt-btn omt-btn-danger";
      cancel.textContent = "Cancel & restore draft";
      cancel.addEventListener("click", () => actions.onCancel(item));

      btns.append(sendNow, picker, cancel);
    }

    top.append(to, subject, whenEl, btns);
    row.append(top);
    list.append(row);
  }
  root.append(list);
  return root;
}

export type ContactsListState = {
  query: string;
  onQuery: (next: string) => void;
  onSelect: (email: string) => void;
};

export function contactsList(doc: Document, contacts: ContactSummary[], state: ContactsListState, now = Date.now()): HTMLElement {
  const root = doc.createElement("div");
  root.className = "omt-tracked";

  const searchBar = doc.createElement("div");
  searchBar.className = "omt-chips";
  const input = doc.createElement("input");
  input.type = "search";
  input.className = "omt-search";
  input.placeholder = "Filter contacts by email…";
  input.value = state.query;
  input.dataset.omtFocus = "contacts:search";
  input.addEventListener("input", () => state.onQuery(input.value));
  searchBar.append(input);
  root.append(searchBar);

  if (contacts.length === 0) {
    const empty = doc.createElement("p");
    empty.className = "omt-tracked-empty";
    empty.textContent = state.query ? "No contacts match that filter." : "No contacts yet.";
    root.append(empty);
    return root;
  }

  const list = doc.createElement("div");
  list.className = "omt-tracked-list";
  for (const c of contacts) {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "omt-contact-item";
    btn.dataset.omtFocus = `contact:${c.email}`;
    btn.addEventListener("click", () => state.onSelect(c.email));

    const emailEl = doc.createElement("span");
    emailEl.className = "omt-contact-email";
    emailEl.textContent = c.email;

    const rate = doc.createElement("span");
    rate.className = "omt-contact-rate";
    const parts = [
      c.attributableMessages > 0
        ? `${c.openedMessages} of ${c.attributableMessages} opened`
        : `${c.messages} group ${c.messages === 1 ? "email" : "emails"}`,
    ];
    if (c.appleMppMessages > 0) parts.push(`${c.appleMppMessages} Apple proxy`);
    rate.textContent = parts.join(" · ");

    const last = doc.createElement("span");
    last.className = "omt-tracked-status";
    last.textContent = c.lastOpenAt
      ? `Last opened ${ago(c.lastOpenAt, now)}`
      : c.lastSentAt
        ? `Last sent ${ago(c.lastSentAt, now)}`
        : "";

    btn.append(emailEl, rate, last);
    list.append(btn);
  }
  root.append(list);
  return root;
}

export function contactDetailView(
  doc: Document,
  contact: ContactSummary,
  messages: ContactMessageEntry[],
  opts: { onBack: () => void; onOpenThread: (entry: ContactMessageEntry) => void },
  now = Date.now(),
): HTMLElement {
  const root = doc.createElement("div");
  root.className = "omt-tracked";

  const header = doc.createElement("div");
  header.className = "omt-contact-header";
  const back = doc.createElement("button");
  back.type = "button";
  back.className = "omt-btn";
  back.textContent = "← All contacts";
  back.addEventListener("click", opts.onBack);

  const title = doc.createElement("strong");
  title.className = "omt-contact-title";
  title.textContent = contact.email;

  const stats = doc.createElement("span");
  stats.className = "omt-tracked-status";
  const ratePct =
    contact.attributableMessages > 0
      ? ` (${Math.round((contact.openedMessages / contact.attributableMessages) * 100)}%)`
      : "";
  stats.textContent = `${contact.openedMessages} of ${contact.attributableMessages} opened${ratePct} · ${contact.totalOpens} total opens`;

  header.append(back, title, stats);
  root.append(header);

  if (messages.length === 0) {
    const empty = doc.createElement("p");
    empty.className = "omt-tracked-empty";
    empty.textContent = "No tracked emails to this contact.";
    root.append(empty);
    return root;
  }

  const list = doc.createElement("div");
  list.className = "omt-tracked-list";
  for (const m of messages) {
    const item = doc.createElement("div");
    item.className = `omt-tracked-item${m.attribution === "individual" && m.opens > 0 ? " omt-tracked-opened" : ""}`;
    const head = doc.createElement("div");
    head.className = "omt-tracked-head";

    const row = doc.createElement("a");
    row.className = "omt-tracked-row";
    row.href = m.gmail_thread_id ? `#all/${encodeURIComponent(m.gmail_thread_id)}` : "#";
    row.addEventListener("click", (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      opts.onOpenThread(m);
    });

    const img = doc.createElement("img");
    img.src = statusIconUrl(m.attribution === "individual" ? m.opens : 0, m.attribution === "individual" ? m.appleMpp : 0);
    img.alt = m.opens > 0 ? "Opened" : "Not opened";

    const subject = doc.createElement("span");
    subject.className = "omt-tracked-subject";
    subject.textContent = m.subject || "(no subject)";

    const status = doc.createElement("span");
    status.className = "omt-tracked-status";
    if (m.attribution === "group_unknown") {
      status.textContent =
        m.opens > 0
          ? `Opened (group, recipient unknown) · sent ${ago(m.sent_at ?? m.created_at, now)}`
          : `Group email · sent ${ago(m.sent_at ?? m.created_at, now)}`;
    } else if (m.opens > 0) {
      status.textContent =
        m.opens === 1 ? `Opened ${ago(m.lastOpenAt!, now)}` : `Opened ${m.opens} times, last ${ago(m.lastOpenAt!, now)}`;
    } else if (m.appleMpp > 0) {
      status.classList.add("omt-status-mpp");
      status.textContent = `Apple Mail privacy proxy ${m.lastAppleMppAt ? ago(m.lastAppleMppAt, now) : ""}`.trim();
    } else {
      status.textContent = `Sent ${ago(m.sent_at ?? m.created_at, now)} · not opened`;
    }

    row.append(img, subject, status);
    head.append(row);
    item.append(head);

    if (m.attribution === "individual" && (m.openAts.length > 0 || m.appleMppAts.length > 0)) {
      const times = openList(doc, m.openAts, now, m.appleMppAts);
      times.classList.add("omt-tracked-opens");
      item.append(times);
    }
    list.append(item);
  }
  root.append(list);
  return root;
}

export type ThreadContactRecord = {
  contact: ContactSummary;
  messages: ContactMessageEntry[];
};

/** Compact per-contact open history rendered inside Gmail's thread sidebar panel. */
export function contactSidebarCard(
  doc: Document,
  records: ThreadContactRecord[],
  opts: {
    onOpenContact: (email: string) => void;
    onOpenThread: (entry: ContactMessageEntry) => void;
  },
  now = Date.now(),
): HTMLElement {
  const root = doc.createElement("div");
  root.className = "omt-sidebar-contacts";

  for (const { contact, messages } of records) {
    const card = doc.createElement("div");
    card.className = "omt-sidebar-card";

    const head = doc.createElement("div");
    head.className = "omt-sidebar-card-head";
    const emailBtn = doc.createElement("button");
    emailBtn.type = "button";
    emailBtn.className = "omt-contact-link omt-sidebar-email";
    emailBtn.textContent = contact.email;
    emailBtn.title = `Open full history for ${contact.email}`;
    emailBtn.addEventListener("click", () => opts.onOpenContact(contact.email));
    head.append(emailBtn);
    card.append(head);

    const meta = doc.createElement("div");
    meta.className = "omt-sidebar-meta";
    const pct =
      contact.attributableMessages > 0
        ? ` (${Math.round((contact.openedMessages / contact.attributableMessages) * 100)}%)`
        : "";
    const parts = [
      contact.attributableMessages > 0
        ? `${contact.openedMessages} of ${contact.attributableMessages} opened${pct}`
        : `${contact.messages} group ${contact.messages === 1 ? "email" : "emails"}`,
    ];
    if (contact.appleMppMessages > 0) parts.push(`${contact.appleMppMessages} Apple proxy`);
    if (contact.lastOpenAt) parts.push(`last opened ${ago(contact.lastOpenAt, now)}`);
    meta.textContent = parts.join(" · ");
    card.append(meta);

    const recent = messages.slice(0, 5);
    if (recent.length > 0) {
      const list = doc.createElement("ul");
      list.className = "omt-sidebar-list";
      for (const m of recent) {
        const li = doc.createElement("li");
        const row = doc.createElement("a");
        row.className = "omt-sidebar-row";
        row.href = m.gmail_thread_id ? `#all/${encodeURIComponent(m.gmail_thread_id)}` : "#";
        row.addEventListener("click", (e) => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          opts.onOpenThread(m);
        });
        const img = doc.createElement("img");
        img.src = statusIconUrl(m.attribution === "individual" ? m.opens : 0, m.attribution === "individual" ? m.appleMpp : 0);
        img.alt = m.opens > 0 ? "Opened" : "Not opened";
        const subj = doc.createElement("span");
        subj.className = "omt-sidebar-subj";
        subj.textContent = m.subject || "(no subject)";
        const st = doc.createElement("span");
        st.className = "omt-sidebar-st";
        st.textContent =
          m.attribution === "group_unknown"
            ? m.opens > 0
              ? "group opened"
              : "group"
            : m.opens > 0
              ? `${m.opens}x · ${ago(m.lastOpenAt!, now)}`
              : m.appleMpp > 0
                ? "Apple proxy"
                : "unopened";
        row.append(img, subj, st);
        li.append(row);
        list.append(li);
      }
      card.append(list);
    }

    root.append(card);
  }
  return root;
}
