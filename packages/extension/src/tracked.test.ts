import { beforeAll, describe, expect, it, vi } from "vitest";
import type { TrackedMessage } from "./api.js";
import {
  contactDetailView,
  contactSidebarCard,
  contactsList,
  needsFollowup,
  rowText,
  scheduledList,
  trackedList,
  type ListState,
} from "./tracked.js";

const now = new Date("2026-09-15T20:00:00").getTime();
const h = (n: number) => now - n * 3_600_000;
const msg = (over: Partial<TrackedMessage>): TrackedMessage => ({
  id: "x",
  subject: "Hello",
  recipients: ["ana@startup.io"],
  gmail_thread_id: "t1",
  sent_at: h(5),
  created_at: h(5),
  opens: 0,
  firstOpenAt: null,
  lastOpenAt: null,
  openAts: [],
  late: null,
  ...over,
});

const state = (over: Partial<ListState> = {}): ListState => ({
  filter: "all", expanded: new Set(), onFilter: () => {}, onOpen: () => {}, onToggle: () => {}, ...over,
});

beforeAll(() => {
  (globalThis as any).chrome = { runtime: { getURL: (p: string) => `chrome-extension://x/${p}` } };
});

describe("rowText", () => {
  it("describes unopened, single, and repeated opens relative to now", () => {
    expect(rowText(msg({}), now)).toBe("Sent 5 hours ago · not opened");
    expect(rowText(msg({ opens: 1, lastOpenAt: h(1) }), now)).toBe("Opened 1 hour ago");
    expect(rowText(msg({ opens: 3, lastOpenAt: h(2) }), now)).toBe("Opened 3 times, last 2 hours ago");
  });
});

describe("trackedList", () => {
  it("renders rows that open the thread and shows the late badge", () => {
    const onOpen = vi.fn();
    const el = trackedList(document, [msg({ opens: 1, lastOpenAt: h(1), late: { kind: "after_send", days: 3 } }), msg({ id: "y", gmail_thread_id: null })], state({ onOpen }), now);
    const rows = el.querySelectorAll(".omt-tracked-row");
    expect(rows).toHaveLength(2);
    expect([...el.querySelectorAll(".omt-chip")].map((c) => c.textContent)).toEqual([
      "All2",
      "Opened1",
      "Not opened1",
      "Needs follow-up0",
      "Hot1",
      "Replied0",
    ]);
    expect(el.querySelectorAll(".omt-chip-sep")).toHaveLength(1);
    expect(rows[0].tagName).toBe("A");
    expect(rows[0].querySelector(".omt-status-late")!.textContent).toBe("3 days after sending");
    expect(rows[0].querySelector(".omt-tracked-to")!.textContent).toBe("ana");
    (rows[0] as HTMLAnchorElement).click();
    expect(onOpen.mock.calls[0][0].gmail_thread_id).toBe("t1");
    expect(rows[1].tagName).toBe("A");
    expect(rows[1].getAttribute("href")).toContain("#search/");
    (rows[1] as HTMLAnchorElement).click();
    expect(onOpen.mock.calls[1][0]).toMatchObject({ id: "y", gmail_thread_id: null });
  });

  it("preserves browser navigation for modified clicks", () => {
    const onOpen = vi.fn();
    const el = trackedList(document, [msg({})], state({ onOpen }), now);
    const row = el.querySelector("a")!;
    expect(row.getAttribute("href")).toBe("#all/t1");
    const event = new MouseEvent("click", { ctrlKey: true, cancelable: true });
    row.dispatchEvent(event);
    expect(onOpen).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("filters by chip and reports the change", () => {
    const onFilter = vi.fn();
    const el = trackedList(document, [msg({ opens: 1, lastOpenAt: h(1) }), msg({ id: "y" })], state({ filter: "unopened", onFilter }), now);
    expect(el.querySelectorAll(".omt-tracked-row")).toHaveLength(1);
    el.querySelectorAll<HTMLButtonElement>(".omt-chip")[1].click();
    expect(onFilter).toHaveBeenCalledWith("opened");
  });

  it("expands an opened row to its open times without opening the thread", () => {
    const onOpen = vi.fn();
    const onToggle = vi.fn();
    const opened = msg({ opens: 2, firstOpenAt: h(3), lastOpenAt: h(1), openAts: [h(3), h(1)] });
    const collapsed = trackedList(document, [opened, msg({ id: "y" })], state({ onOpen, onToggle }), now);
    const toggles = collapsed.querySelectorAll<HTMLButtonElement>(".omt-tracked-toggle");
    expect(toggles).toHaveLength(1);
    expect(toggles[0].getAttribute("aria-expanded")).toBe("false");
    expect(collapsed.querySelector(".omt-tracked-opens")).toBeNull();
    toggles[0].click();
    expect(onToggle).toHaveBeenCalledWith("x");
    expect(onOpen).not.toHaveBeenCalled();

    const open = trackedList(document, [opened], state({ expanded: new Set(["x"]) }), now);
    expect(open.querySelector(".omt-tracked-toggle")!.getAttribute("aria-expanded")).toBe("true");
    expect([...open.querySelectorAll(".omt-tracked-opens li")].map((li) => li.textContent)).toEqual(["5:00 PMtoday", "7:00 PMtoday"]);
  });

  it("has empty states", () => {
    expect(trackedList(document, [], state()).textContent).toContain("No tracked messages yet");
    expect(trackedList(document, [msg({})], state({ filter: "opened" })).textContent).toContain("Nothing matches these filters");
  });

  it("renders scheduled sends with Send now and Cancel actions", () => {
    const onSendNow = vi.fn();
    const onCancel = vi.fn();
    const item = {
      id: "ob1",
      accountEmail: "me@cornell.edu",
      messageId: "m1",
      status: "queued" as const,
      sendAt: now + 3_600_000,
      isScheduled: true,
      subject: "Follow up",
      recipients: { to: ["alice@example.com"], cc: [], bcc: [] },
      threadId: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    const el = scheduledList(document, [item], { onSendNow, onReschedule: () => {}, onCancel }, now);
    const buttons = el.querySelectorAll<HTMLButtonElement>("button");
    buttons[0].click();
    buttons[1].click();
    expect(onSendNow).toHaveBeenCalledWith(item);
    expect(onCancel).toHaveBeenCalledWith(item);
  });

  it("renders contacts directory and contact detail with legacy group attribution", () => {
    const onSelect = vi.fn();
    const contact = {
      email: "alice@example.com",
      messages: 2,
      attributableMessages: 1,
      openedMessages: 1,
      appleMppMessages: 0,
      totalOpens: 2,
      lastOpenAt: h(1),
      lastSentAt: h(2),
    };
    const listEl = contactsList(document, [contact], { query: "", onQuery: () => {}, onSelect }, now);
    expect(listEl.textContent).toContain("1 of 1 opened");
    listEl.querySelector<HTMLButtonElement>(".omt-contact-item")!.click();
    expect(onSelect).toHaveBeenCalledWith("alice@example.com");

    const detailEl = contactDetailView(
      document,
      contact,
      [
        {
          id: "m1",
          subject: "Old group",
          recipients: ["alice@example.com", "bob@example.com"],
          gmail_thread_id: "t1",
          sent_at: h(4),
          created_at: h(4),
          attribution: "group_unknown",
          opens: 1,
          firstOpenAt: h(3),
          lastOpenAt: h(3),
          openAts: [h(3)],
          late: null,
          appleMpp: 0,
          lastAppleMppAt: null,
          appleMppAts: [],
        },
      ],
      { onBack: () => {}, onOpenThread: () => {} },
      now,
    );
    expect(detailEl.textContent).toContain("Opened (group, recipient unknown)");
  });

  it("filters Needs follow-up (>=24h, no reply, not dismissed), prioritizes opened leads, and renders thread contact sidebar", () => {
    const oldOpened = msg({ id: "a", sent_at: h(48), opens: 2, lastOpenAt: h(6), subject: "Opened no reply" });
    const oldUnopened = msg({ id: "b", sent_at: h(72), opens: 0, subject: "Unopened no reply" });
    const oldReplied = msg({ id: "c", sent_at: h(48), opens: 1, lastOpenAt: h(10), replied_at: h(5), subject: "Already replied" });
    const oldDismissed = msg({ id: "d", sent_at: h(48), followup_dismissed_at: h(2), subject: "Dismissed" });
    const tooRecent = msg({ id: "e", sent_at: h(3), subject: "Just sent" });

    expect(needsFollowup(oldOpened, now)).toBe(true);
    expect(needsFollowup(oldUnopened, now)).toBe(true);
    expect(needsFollowup(oldReplied, now)).toBe(false);
    expect(needsFollowup(oldDismissed, now)).toBe(false);
    expect(needsFollowup(tooRecent, now)).toBe(false);

    const onDismissFollowup = vi.fn();
    const onCheckReplies = vi.fn();
    const el = trackedList(
      document,
      [oldUnopened, oldOpened, oldReplied, oldDismissed, tooRecent],
      state({ filter: "followup", onDismissFollowup, onCheckReplies }),
      now,
    );
    const subjects = [...el.querySelectorAll(".omt-tracked-subject")].map((s) => s.textContent);
    expect(subjects).toEqual(["Opened no reply", "Unopened no reply"]);
    el.querySelector<HTMLButtonElement>(".omt-followup-refresh")!.click();
    expect(onCheckReplies).toHaveBeenCalledOnce();
    el.querySelector<HTMLButtonElement>(".omt-dismiss-btn")!.click();
    expect(onDismissFollowup).toHaveBeenCalledWith("a");

    // Inline thread contact sidebar card
    const onOpenContact = vi.fn();
    const onOpenThread = vi.fn();
    const card = contactSidebarCard(
      document,
      [
        {
          contact: {
            email: "alice@example.com",
            messages: 3,
            attributableMessages: 3,
            openedMessages: 2,
            appleMppMessages: 0,
            totalOpens: 4,
            lastOpenAt: h(1),
            lastSentAt: h(2),
          },
          messages: [
            {
              id: "m1",
              subject: "Proposal",
              recipients: ["alice@example.com"],
              gmail_thread_id: "t1",
              sent_at: h(2),
              created_at: h(2),
              attribution: "individual",
              opens: 2,
              firstOpenAt: h(2),
              lastOpenAt: h(1),
              openAts: [h(2), h(1)],
              late: null,
              appleMpp: 0,
              lastAppleMppAt: null,
              appleMppAts: [],
            },
          ],
        },
      ],
      { onOpenContact, onOpenThread },
      now,
    );
    expect(card.textContent).toContain("2 of 3 opened (67%)");
    card.querySelector<HTMLButtonElement>(".omt-sidebar-email")!.click();
    expect(onOpenContact).toHaveBeenCalledWith("alice@example.com");
    card.querySelector<HTMLAnchorElement>(".omt-sidebar-row")!.click();
    expect(onOpenThread).toHaveBeenCalledOnce();
  });

  it("supports search, time range, Hot/Replied/Apple proxy chips, contextual sort labels, and contact sorting", () => {
    const items = [
      msg({ id: "1", subject: "Exa Offer", recipients: ["lauren@exa.ai"], sent_at: h(5), opens: 5, lastOpenAt: h(1) }),
      msg({ id: "2", subject: "Group kickoff", recipients: ["a@x.com", "b@x.com"], sent_at: h(40), opens: 1, lastOpenAt: h(2), replied_at: h(1) }),
      msg({ id: "3", subject: "Old note", recipients: ["old@x.com"], sent_at: h(24 * 20), opens: 0, appleMpp: 1, lastAppleMppAt: h(24 * 19) }),
    ];

    const searchExa = trackedList(document, items, state({ query: "exa" }), now);
    expect([...searchExa.querySelectorAll(".omt-tracked-subject")].map((s) => s.textContent)).toEqual(["Exa Offer"]);

    // Time range 24h excludes 20-day old message and marks the time selector active
    const last24h = trackedList(document, items, state({ timeRange: "24h", onTimeRange: () => {} }), now);
    expect([...last24h.querySelectorAll(".omt-tracked-subject")].map((s) => s.textContent)).toEqual(["Exa Offer", "Group kickoff"]);
    expect(last24h.querySelector(".omt-select-wrap")?.classList.contains("omt-select-active")).toBe(true);

    // Hot chip picks >= 3 opens and shows "Most opens" as default sort label
    const hot = trackedList(document, items, state({ filter: "hot", onSortBy: () => {} }), now);
    expect([...hot.querySelectorAll(".omt-tracked-subject")].map((s) => s.textContent)).toEqual(["Exa Offer"]);
    expect(hot.querySelector(".omt-select-sort .omt-select-label")?.textContent).toBe("Most opens");

    // Replied chip picks replied messages
    const replied = trackedList(document, items, state({ filter: "replied" }), now);
    expect([...replied.querySelectorAll(".omt-tracked-subject")].map((s) => s.textContent)).toEqual(["Group kickoff"]);

    // Apple proxy chip appears when apple proxy items exist
    const apple = trackedList(document, items, state({ filter: "apple_mpp" }), now);
    expect([...apple.querySelectorAll(".omt-tracked-subject")].map((s) => s.textContent)).toEqual(["Old note"]);

    // Sort by most opens & oldest sent
    const mostOpens = trackedList(document, items, state({ sortBy: "most_opens" }), now);
    expect([...mostOpens.querySelectorAll(".omt-tracked-subject")].map((s) => s.textContent)).toEqual([
      "Exa Offer",
      "Group kickoff",
      "Old note",
    ]);
    const oldest = trackedList(document, items, state({ sortBy: "oldest" }), now);
    expect([...oldest.querySelectorAll(".omt-tracked-subject")].map((s) => s.textContent)).toEqual([
      "Old note",
      "Group kickoff",
      "Exa Offer",
    ]);

    // Clear filters button resets filters when toolbar callbacks are wired; only time & sort selects exist
    const onReset = vi.fn();
    const withToolbar = trackedList(
      document,
      items,
      state({ query: "exa", onQuery: () => {}, onTimeRange: () => {}, onSortBy: () => {}, onReset }),
      now,
    );
    expect(withToolbar.querySelectorAll(".omt-toolbar select")).toHaveLength(2);
    withToolbar.querySelector<HTMLButtonElement>(".omt-toolbar .omt-clear-btn")!.click();
    expect(onReset).toHaveBeenCalledOnce();

    // Contact sorting by open rate and most emailed
    const c1 = { email: "low@x.com", messages: 10, attributableMessages: 10, openedMessages: 2, appleMppMessages: 0, totalOpens: 2, lastOpenAt: h(1), lastSentAt: h(1) };
    const c2 = { email: "high@x.com", messages: 2, attributableMessages: 2, openedMessages: 2, appleMppMessages: 0, totalOpens: 9, lastOpenAt: h(5), lastSentAt: h(5) };
    const byRate = contactsList(document, [c1, c2], { query: "", sortBy: "open_rate", onQuery: () => {}, onSortBy: () => {}, onSelect: () => {} }, now);
    expect([...byRate.querySelectorAll(".omt-contact-email")].map((e) => e.textContent)).toEqual(["high@x.com", "low@x.com"]);
    const byEmailed = contactsList(document, [c1, c2], { query: "", sortBy: "most_emailed", onQuery: () => {}, onSortBy: () => {}, onSelect: () => {} }, now);
    expect([...byEmailed.querySelectorAll(".omt-contact-email")].map((e) => e.textContent)).toEqual(["low@x.com", "high@x.com"]);
  });
});
