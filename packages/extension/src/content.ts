import * as InboxSDK from "@inboxsdk/core";
import Kefir from "kefir";
import {
  createApi,
  createStatusBatcher,
  type ContactMessageEntry,
  type ContactSummary,
  type OutboxItem,
  type ThreadSummary,
  type TrackedMessage,
} from "./api.js";
import { messageSearch, ownPixelId } from "./link.js";
import { rowImage, statusElement } from "./marks.js";
import { expandOperator, OPERATORS } from "./search.js";
import { loadSettings } from "./settings.js";
import { when } from "./time.js";
import {
  contactDetailView,
  contactSidebarCard,
  contactsList,
  scheduledList,
  sectionBar,
  trackedList,
  type ContactSort,
  type Filter,
  type Section,
  type SortBy,
  type ThreadContactRecord,
  type TimeRange,
} from "./tracked.js";
import { hasPixel } from "./tracking.js";

const APP_ID = "sdk_openmt_62266805c2";
const TRACKED_ROUTE = "tracked";
const REFRESH_MS = 30_000;
const MAX_GROUP_RECIPIENTS = 25;
const log = (...args: unknown[]) => console.log("[open-mailtrack]", ...args);

function formatContact(c: { name?: string | null; emailAddress: string }): string {
  const email = c.emailAddress.trim();
  const name = c.name?.replace(/[<>]/g, "").trim();
  if (!name || name.toLowerCase() === email.toLowerCase()) return email;
  const safeName = /["\\,;]/.test(name) ? `"${name.replace(/["\\]/g, "\\$&")}"` : name;
  return `${safeName} <${email}>`;
}

function uniqueExternalRecipients(
  compose: InboxSDK.ComposeView,
  me: string,
): { to: string[]; cc: string[]; bcc: string[]; externalCount: number } {
  const toContacts = compose.getToRecipients();
  const ccContacts = compose.getCcRecipients();
  const bccContacts = compose.getBccRecipients();
  const external = new Set<string>();
  for (const c of [...toContacts, ...ccContacts, ...bccContacts]) {
    const addr = c.emailAddress.trim().toLowerCase();
    if (addr && addr !== me) external.add(addr);
  }
  return {
    to: toContacts.map(formatContact),
    cc: ccContacts.map(formatContact),
    bcc: bccContacts.map(formatContact),
    externalCount: external.size,
  };
}

function schedulePresets(now = Date.now()): { label: string; sendAt: number }[] {
  const atHour = (daysAhead: number, hour: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + daysAhead);
    d.setHours(hour, 0, 0, 0);
    return d.getTime();
  };
  const d = new Date(now);
  const daysToMonday = ((8 - d.getDay()) % 7) || 7;
  return [
    { label: "Tomorrow morning (8:00 AM)", sendAt: atHour(1, 8) },
    { label: "Tomorrow afternoon (1:00 PM)", sendAt: atHour(1, 13) },
    { label: "Next Monday morning (8:00 AM)", sendAt: atHour(daysToMonday, 8) },
  ];
}

function toDatetimeLocal(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function main() {
  const settings = await loadSettings();
  if (!settings) {
    log("not configured; open the extension options");
    return;
  }
  const api = createApi(settings);
  const status = createStatusBatcher(api);
  const sdk = await InboxSDK.load(2, APP_ID);
  const me = sdk.User.getEmailAddress().toLowerCase();

  const connectedAccounts = new Set<string>();
  let accountState: "unknown" | "connected" | "disconnected" = "unknown";
  const refreshConnected = async () => {
    try {
      const { accounts } = await api.accounts();
      connectedAccounts.clear();
      for (const a of accounts) connectedAccounts.add(a.email.toLowerCase());
      accountState = connectedAccounts.has(me) ? "connected" : "disconnected";
    } catch (err) {
      // Keep last known state ("unknown" on cold-start outage) so we fail closed rather than silently sending untracked.
      log("could not check connected accounts", err);
    }
  };
  await refreshConnected();
  window.addEventListener("focus", () => void refreshConnected());

  const isConfirmedDisconnected = () => accountState === "disconnected";
  const isConnected = () => accountState === "connected";

  let pendingRouteState: { section: Section; contactEmail?: string } | null = null;
  let routeStateSetter: ((next: { section: Section; contactEmail?: string }) => void) | null = null;

  const openTracked = (next: { section: Section; contactEmail?: string }) => {
    if (routeStateSetter) {
      routeStateSetter(next);
    } else {
      pendingRouteState = next;
    }
    sdk.Router.goto(TRACKED_ROUTE, {}).catch((err) => log("could not open Tracked view", err));
  };

  /** Emits immediately for each subscriber and then every REFRESH_MS while the page is visible. */
  const ticks = Kefir.interval(REFRESH_MS, null)
    .filter(() => document.visibilityState === "visible")
    .toProperty(() => null);

  const openOptions = () => {
    chrome.runtime.sendMessage?.({ type: "openOptions" });
  };

  const showButter = (opts: { text: string; time?: number; buttons?: { title: string; onClick: () => void }[] }) => {
    sdk.ButterBar?.showMessage?.({
      text: opts.text,
      time: opts.time ?? 6000,
      buttons: opts.buttons,
    });
  };

  sdk.Compose.registerComposeViewHandler((compose) => {
    let enabled = !isConfirmedDisconnected();
    let sending = false;
    let clientRequestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const draftSavedWaiters: (() => void)[] = [];
    compose.on("draftSaved", () => {
      while (draftSavedWaiters.length > 0) draftSavedWaiters.shift()?.();
    });

    if (isConfirmedDisconnected()) {
      try {
        const notice = compose.addComposeNotice?.({ height: 30 });
        if (notice?.el) {
          const bar = notice.el.ownerDocument.createElement("div");
          bar.className = "omt-compose-notice";
          const span = notice.el.ownerDocument.createElement("span");
          span.textContent = `open-mailtrack: ${me} is not connected — sending untracked.`;
          const btn = notice.el.ownerDocument.createElement("button");
          btn.type = "button";
          btn.className = "omt-btn";
          btn.textContent = "Connect account";
          btn.addEventListener("click", openOptions);
          bar.append(span, btn);
          notice.el.append(bar);
        }
      } catch {
        // Older or mock InboxSDK views without addComposeNotice still work.
      }
    }

    const toggle = Kefir.pool<boolean, unknown>();
    compose.addButton(
      toggle.toProperty(() => enabled).map((on) => ({
        title: isConfirmedDisconnected() ? "Account not connected" : on ? "Tracking on" : "Tracking off",
        tooltip: isConfirmedDisconnected()
          ? "Connect this Gmail account in open-mailtrack options to enable per-recipient tracking."
          : on
            ? "Per-recipient open tracking is on (via your server). Click to turn off."
            : "Open tracking is off for this message. Click to turn on.",
        iconUrl: chrome.runtime.getURL(on ? "icons/track-on.svg" : "icons/track-off.svg"),
        type: "MODIFIER" as const,
        orderHint: 0,
        onClick: () => {
          if (isConfirmedDisconnected()) {
            openOptions();
            return;
          }
          enabled = !enabled;
          toggle.plug(Kefir.constant(enabled));
        },
      })),
    );

    async function dispatchViaOutbox(opts: { sendAt?: number; isScheduled?: boolean; undoDelayMs?: number }) {
      if (sending) return;
      const { to, cc, bcc, externalCount } = uniqueExternalRecipients(compose, me);
      if (externalCount === 0) return;
      if (externalCount > MAX_GROUP_RECIPIENTS) {
        showButter({
          text: `Per-recipient tracking is capped at ${MAX_GROUP_RECIPIENTS} recipients (found ${externalCount}). Turn tracking off or use openmt CLI.`,
          time: 10_000,
        });
        return;
      }

      sending = true;
      try {
        if (accountState === "unknown") {
          await refreshConnected();
          if (accountState === "unknown") {
            throw new Error("Could not reach open-mailtrack server");
          }
          if (accountState === "disconnected") {
            throw new Error(`Account ${me} is not connected in open-mailtrack options`);
          }
        }

        const fromContact = compose.getFromContact?.();
        const from = fromContact?.emailAddress ? formatContact(fromContact) : me;
        const html = compose.getHTMLContent?.() ?? compose.getBodyElement().innerHTML;
        const subject = compose.getSubject();
        // Only attach threadId for actual replies; on brand-new compose windows, getThreadID() is the ephemeral draft thread.
        const threadId = compose.isReply?.() ? compose.getThreadID?.() || null : null;
        const composeEl = compose.getElement?.();
        const hasAttachments = Boolean(
          composeEl?.querySelector('[data-tooltip*="Remove attachment"], [aria-label*="Remove attachment"], .vI, .dL'),
        );
        const draftMessageId = compose.getInitialMessageID?.() || null;
        let draftId = (await compose.getCurrentDraftID?.().catch(() => null)) || null;
        if (hasAttachments && !draftId) {
          // Wait briefly for Gmail to finish saving the newly attached file into the draft.
          const waitForDraftSaved = new Promise<void>((resolve) => {
            draftSavedWaiters.push(resolve);
            setTimeout(resolve, 4000);
          });
          if (compose.getDraftID) {
            draftId =
              (await Promise.race([
                compose.getDraftID().catch(() => null),
                waitForDraftSaved.then(() => compose.getCurrentDraftID?.().catch(() => null) ?? null),
              ])) || null;
          } else {
            await waitForDraftSaved;
            draftId = (await compose.getCurrentDraftID?.().catch(() => null)) || null;
          }
        }

        const res = await api.enqueueOutbox({
          sender: me,
          from,
          to,
          cc,
          bcc,
          subject,
          html,
          threadId,
          draftId,
          draftMessageId,
          hasAttachments,
          clientRequestId,
          sendAt: opts.sendAt,
          isScheduled: opts.isScheduled,
          undoDelayMs: opts.undoDelayMs,
        });

        clientRequestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        // InboxSDK's close() is a no-op for inline replies; discard() closes the inline compose cleanly.
        if (compose.isInlineReplyForm?.()) {
          compose.discard?.();
        } else {
          compose.close?.();
        }

        const undoAction = async () => {
          try {
            const canceled = await api.cancelOutbox(res.outboxId, true);
            if (canceled.draftMessageId && sdk.Compose.openDraftByMessageID) {
              await sdk.Compose.openDraftByMessageID(canceled.draftMessageId);
            }
            showButter({
              text:
                canceled.draftId || canceled.draftMessageId
                  ? "Send canceled. Draft restored."
                  : "Send canceled.",
            });
          } catch (err) {
            showButter({ text: `Could not undo: ${(err as Error).message}`, time: 8000 });
          }
        };

        const undoTimeMs = res.remainingMs ?? (opts.undoDelayMs ?? 0);
        if (opts.isScheduled && opts.sendAt) {
          showButter({
            text: `Scheduled for ${when(opts.sendAt, Date.now())}`,
            time: 8000,
            buttons: [
              { title: "View scheduled", onClick: () => openTracked({ section: "scheduled" }) },
              { title: "Undo", onClick: () => void undoAction() },
            ],
          });
        } else if (undoTimeMs > 0) {
          showButter({
            text: "Sending message…",
            time: undoTimeMs,
            buttons: [{ title: "Undo", onClick: () => void undoAction() }],
          });
        } else {
          showButter({ text: "Queued to send…" });
        }
      } catch (err) {
        // Fail closed: keep compose window and draft intact so nothing is lost.
        log("tracked send failed", err);
        showButter({
          text: `Tracked send failed: ${(err as Error).message}. Your draft is still open.`,
          time: 12_000,
        });
      } finally {
        sending = false;
      }
    }

    compose.on("presending", (event) => {
      if (isConfirmedDisconnected() || !enabled) return;
      const { externalCount } = uniqueExternalRecipients(compose, me);
      if (externalCount === 0) return;
      event?.cancel?.();
      if (externalCount > MAX_GROUP_RECIPIENTS) {
        showButter({
          text: `Per-recipient tracking is capped at ${MAX_GROUP_RECIPIENTS} recipients (found ${externalCount}). Turn tracking off or use openmt CLI.`,
          time: 10_000,
        });
        return;
      }
      void dispatchViaOutbox({ undoDelayMs: settings.undoDelaySec * 1000 });
    });

    compose.on("scheduleSendMenuOpening", (event) => {
      if (isConfirmedDisconnected() || !enabled) return;
      const { externalCount } = uniqueExternalRecipients(compose, me);
      if (externalCount === 0) return;
      event?.cancel?.();
      if (!sdk.Widgets?.showModalView) return;

      const doc = compose.getBodyElement().ownerDocument;
      const box = doc.createElement("div");
      box.className = "omt-schedule-modal";

      const presetsWrap = doc.createElement("div");
      presetsWrap.className = "omt-schedule-presets";
      let modal: InboxSDK.ModalView | null = null;

      for (const preset of schedulePresets()) {
        const btn = doc.createElement("button");
        btn.type = "button";
        btn.className = "omt-schedule-preset";
        const label = doc.createElement("span");
        label.textContent = preset.label;
        const timeEl = doc.createElement("span");
        timeEl.className = "omt-tracked-status";
        timeEl.textContent = when(preset.sendAt, Date.now());
        btn.append(label, timeEl);
        btn.addEventListener("click", () => {
          modal?.close();
          void dispatchViaOutbox({ sendAt: preset.sendAt, isScheduled: true });
        });
        presetsWrap.append(btn);
      }

      const customLabel = doc.createElement("label");
      customLabel.textContent = "Pick date and time:";
      const input = doc.createElement("input");
      input.type = "datetime-local";
      input.className = "omt-datetime";
      input.value = toDatetimeLocal(Date.now() + 3_600_000);
      box.append(presetsWrap, customLabel, input);

      modal = sdk.Widgets.showModalView({
        title: "Schedule tracked send",
        el: box,
        buttons: [
          {
            text: "Schedule",
            type: "PRIMARY_ACTION",
            onClick: () => {
              const sendAt = new Date(input.value).getTime();
              if (!Number.isFinite(sendAt) || sendAt <= Date.now()) {
                showButter({ text: "Pick a future date and time." });
                return;
              }
              modal?.close();
              void dispatchViaOutbox({ sendAt, isScheduled: true });
            },
          },
          {
            text: "Cancel",
            onClick: () => modal?.close(),
          },
        ],
      });
    });
  });

  sdk.Conversations.registerMessageViewHandler(async (message) => {
    if (message.getSender().emailAddress.toLowerCase() !== me) return;
    const messageId = await message.getMessageIDAsync();
    const reportView = () => api.view(messageId).catch((err) => log(err));
    reportView();
    let current: HTMLElement | null = null;
    let expanded = false;
    const place = () => {
      if (!current) return;
      const body = message.getBodyElement();
      if (current.nextElementSibling === body) return;
      body.parentElement?.insertBefore(current, body);
    };
    const observer = new MutationObserver((records) => {
      if (records.some((r) => [...r.addedNodes].some((n) => n instanceof Element && hasPixel(n, settings.serverUrl)))) {
        reportView();
      }
      place();
    });
    observer.observe(message.getElement(), { childList: true, subtree: true });
    message.on("destroy", () => observer.disconnect());

    const stop = Kefir.fromEvents<void, unknown>(message, "destroy");
    ticks
      .takeUntilBy(stop)
      .flatMapLatest(() =>
        Kefir.fromPromise(
          (async () => {
            const summary = await status.message(messageId);
            if (summary) return summary;
            // Legacy message recovery (for emails sent before the unified server SMTP upgrade).
            const id = ownPixelId(message.getBodyElement(), settings.serverUrl, (img) => message.isElementInQuotedArea(img));
            if (!id) return;
            try {
              const threadId = await message.getThreadView().getThreadIDAsync();
              await api.recoverLink(id, messageId, threadId, me);
              return await status.message(messageId);
            } catch (err) {
              log("could not recover message link", err);
            }
          })(),
        ),
      )
      .onValue((summary) => {
        if (!summary) return;
        current?.remove();
        current = statusElement(
          message.getBodyElement().ownerDocument,
          summary,
          Date.now(),
          {
            expanded,
            onToggle: (next) => {
              expanded = next;
            },
          },
          {
            onContactClick: (email) => openTracked({ section: "contacts", contactEmail: email }),
          },
        );
        place();
      });
  });

  sdk.Conversations.registerThreadViewHandler?.(async (threadView) => {
    let destroyed = false;
    threadView.on("destroy", () => {
      destroyed = true;
    });
    try {
      const participants = new Set<string>();
      for (const mv of threadView.getMessageViewsAll?.() ?? []) {
        try {
          const sender = mv.getSender?.()?.emailAddress?.trim().toLowerCase();
          if (sender && sender !== me) participants.add(sender);
          const recs = await mv.getRecipientsFull?.().catch(() => []);
          for (const r of recs ?? []) {
            const addr = r.emailAddress?.trim().toLowerCase();
            if (addr && addr !== me) participants.add(addr);
          }
        } catch {
          // Skip unloaded messages safely.
        }
      }
      const emails = [...participants].slice(0, 8);
      if (emails.length === 0 || destroyed) return;

      const settled = await Promise.all(
        emails.map((email) => api.getContact(email, me).catch(() => null)),
      );
      if (destroyed) return;
      const records = settled.filter((r): r is ThreadContactRecord => r !== null);
      if (records.length === 0) return;

      const el = contactSidebarCard(
        document,
        records,
        {
          onOpenContact: (email) => openTracked({ section: "contacts", contactEmail: email }),
          onOpenThread: (entry) => {
            if (entry.gmail_thread_id) {
              sdk.Router.goto(sdk.Router.NativeRouteIDs.THREAD, { threadID: entry.gmail_thread_id }).catch((err) =>
                log("could not open thread", err),
              );
            }
          },
        },
      );
      threadView.addSidebarContentPanel({
        title: "Open history",
        iconUrl: chrome.runtime.getURL("icons/opened.svg"),
        el,
      });
    } catch (err) {
      log("thread contact sidebar failed", err);
    }
  });

  sdk.Lists.registerThreadRowViewHandler((row) => {
    if (row.destroyed) return;
    const threadId = Kefir.fromPromise<string, unknown>(row.getThreadIDAsync());
    const image = threadId.flatMap((id) =>
      ticks.flatMapLatest(() =>
        Kefir.fromPromise<ThreadSummary | undefined, unknown>(status.thread(id)).map((s) => (s ? rowImage(s) : null)),
      ),
    );
    row.addImage(image);
  });

  sdk.Router.handleCustomRoute(TRACKED_ROUTE, (route) => {
    const el = route.getElement();
    const doc = el.ownerDocument;
    const note = (text: string) => {
      const p = doc.createElement("p");
      p.className = "omt-tracked-empty";
      p.textContent = text;
      el.replaceChildren(p);
    };
    note("Loading…");

    let alive = true;
    let section: Section = pendingRouteState?.section ?? "messages";
    let selectedContact: string | null = pendingRouteState?.contactEmail ?? null;
    pendingRouteState = null;

    let filter: Filter = "all";
    let messageQuery = "";
    let timeRange: TimeRange = "all";
    let sortBy: SortBy = "default";
    let contactQuery = "";
    let contactSort: ContactSort = "last_opened";
    let messages: TrackedMessage[] = [];
    let scheduled: OutboxItem[] = [];
    let contacts: ContactSummary[] = [];
    let contactDetail: { contact: ContactSummary; messages: ContactMessageEntry[] } | null = null;
    const expanded = new Set<string>();

    const openThreadById = (threadId: string | null, fallbackMessage?: TrackedMessage) => {
      const navigation = threadId
        ? sdk.Router.goto(sdk.Router.NativeRouteIDs.THREAD, { threadID: threadId })
        : fallbackMessage
          ? sdk.Router.goto(sdk.Router.NativeRouteIDs.SEARCH, { query: messageSearch(fallbackMessage) })
          : Promise.resolve();
      navigation.catch((err) => log("could not open tracked message", err));
    };

    const loadContactDetail = async (email: string) => {
      selectedContact = email;
      contactDetail = null;
      draw();
      try {
        const res = await api.getContact(email, me);
        if (!alive || selectedContact !== email) return;
        contactDetail = res;
        draw();
      } catch (err) {
        log("contact detail failed", err);
      }
    };

    const draw = () => {
      const activeEl = doc.activeElement instanceof HTMLElement && el.contains(doc.activeElement) ? doc.activeElement : null;
      const focused = activeEl?.dataset.omtFocus;
      const selStart = activeEl instanceof HTMLInputElement ? activeEl.selectionStart : null;
      const selEnd = activeEl instanceof HTMLInputElement ? activeEl.selectionEnd : null;
      const wrapper = doc.createElement("div");
      wrapper.append(
        sectionBar(
          doc,
          section,
          { messages: messages.length, scheduled: scheduled.length, contacts: contacts.length },
          (next) => {
            section = next;
            if (next !== "contacts") selectedContact = null;
            draw();
          },
        ),
      );

      if (section === "messages") {
        wrapper.append(
          trackedList(doc, messages, {
            filter,
            expanded,
            query: messageQuery,
            timeRange,
            sortBy,
            onFilter: (next) => {
              filter = next;
              draw();
            },
            onQuery: (next) => {
              messageQuery = next;
              draw();
            },
            onTimeRange: (next) => {
              timeRange = next;
              draw();
            },
            onSortBy: (next) => {
              sortBy = next;
              draw();
            },
            onReset: () => {
              filter = "all";
              messageQuery = "";
              timeRange = "all";
              sortBy = "default";
              draw();
            },
            onOpen: (m) => openThreadById(m.gmail_thread_id, m),
            onToggle: (id) => {
              if (!expanded.delete(id)) expanded.add(id);
              draw();
            },
            onContactClick: (email) => {
              section = "contacts";
              void loadContactDetail(email);
            },
            onDismissFollowup: async (id) => {
              try {
                await api.dismissFollowup(id, true);
                showButter({ text: "Dismissed from Needs follow-up." });
                await render();
              } catch (err) {
                showButter({ text: (err as Error).message });
              }
            },
            onCheckReplies: async () => {
              try {
                showButter({ text: "Checking Gmail threads for replies…" });
                const res = await api.refreshFollowups(me);
                const parts: string[] = [];
                if (res.replied > 0) parts.push(`${res.replied} new ${res.replied === 1 ? "reply" : "replies"}`);
                if (res.bounced && res.bounced > 0) parts.push(`${res.bounced} ${res.bounced === 1 ? "bounce" : "bounces"}`);
                showButter({
                  text:
                    parts.length > 0
                      ? `Found ${parts.join(" and ")} across ${res.checked} checked threads.`
                      : `Checked ${res.checked} threads. No new replies or bounces yet.`,
                });
                await render();
              } catch (err) {
                showButter({ text: (err as Error).message });
              }
            },
          }),
        );
      } else if (section === "scheduled") {
        wrapper.append(
          scheduledList(doc, scheduled, {
            onSendNow: async (item) => {
              try {
                await api.rescheduleOutbox(item.id, Date.now());
                showButter({ text: "Sending now…" });
                await render();
              } catch (err) {
                showButter({ text: (err as Error).message });
              }
            },
            onReschedule: async (item, sendAt) => {
              try {
                await api.rescheduleOutbox(item.id, sendAt);
                showButter({ text: `Rescheduled for ${when(sendAt, Date.now())}` });
                await render();
              } catch (err) {
                showButter({ text: (err as Error).message });
              }
            },
            onCancel: async (item) => {
              try {
                const res = await api.cancelOutbox(item.id, true);
                if (res.draftMessageId && sdk.Compose.openDraftByMessageID) {
                  await sdk.Compose.openDraftByMessageID(res.draftMessageId);
                }
                showButter({
                  text: res.draftId || res.draftMessageId ? "Scheduled send canceled. Draft restored." : "Scheduled send canceled.",
                });
                await render();
              } catch (err) {
                showButter({ text: (err as Error).message });
              }
            },
          }),
        );
      } else if (selectedContact) {
        if (contactDetail) {
          wrapper.append(
            contactDetailView(doc, contactDetail.contact, contactDetail.messages, {
              onBack: () => {
                selectedContact = null;
                contactDetail = null;
                draw();
              },
              onOpenThread: (entry) => openThreadById(entry.gmail_thread_id),
            }),
          );
        } else {
          const p = doc.createElement("p");
          p.className = "omt-tracked-empty";
          p.textContent = `Loading history for ${selectedContact}…`;
          wrapper.append(p);
        }
      } else {
        const filtered = contactQuery
          ? contacts.filter((c) => c.email.includes(contactQuery.trim().toLowerCase()))
          : contacts;
        wrapper.append(
          contactsList(doc, filtered, {
            query: contactQuery,
            sortBy: contactSort,
            onQuery: (next) => {
              contactQuery = next;
              draw();
            },
            onSortBy: (next) => {
              contactSort = next;
              draw();
            },
            onSelect: (email) => void loadContactDetail(email),
          }),
        );
      }

      el.replaceChildren(wrapper);
      if (focused) {
        const nextFocused = el.querySelector<HTMLElement>(`[data-omt-focus="${CSS.escape(focused)}"]`);
        nextFocused?.focus();
        if (nextFocused instanceof HTMLInputElement && selStart !== null && selEnd !== null) {
          try {
            nextFocused.setSelectionRange(selStart, selEnd);
          } catch {
            // ignore inputs that do not support selection ranges
          }
        }
      }
    };

    const render = async () => {
      try {
        const [msgRes, outboxRes, contactsRes] = await Promise.all([
          api.list(me, 0, 500),
          api.listOutbox(me).catch(() => ({ items: [] as OutboxItem[] })),
          api.listContacts(me).catch(() => ({ total: 0, contacts: [] as ContactSummary[] })),
        ]);
        if (!alive) return;
        messages = msgRes.messages;
        scheduled = outboxRes.items;
        contacts = contactsRes.contacts;
        if (selectedContact) {
          const target = selectedContact;
          const refreshed = await api.getContact(target, me).catch(() => null);
          if (alive && selectedContact === target && refreshed) contactDetail = refreshed;
        }
        draw();
      } catch (err) {
        log("tracked list failed", err);
        if (alive) note("Could not load tracked messages.");
      }
    };

    routeStateSetter = (next) => {
      section = next.section;
      if (next.contactEmail) {
        void loadContactDetail(next.contactEmail);
      } else {
        selectedContact = null;
        draw();
      }
    };

    void render();
    const timer = setInterval(() => document.visibilityState === "visible" && render(), REFRESH_MS);
    route.on("destroy", () => {
      alive = false;
      routeStateSetter = null;
      clearInterval(timer);
    });
  });

  for (const term of OPERATORS) {
    sdk.Search.registerSearchQueryRewriter({
      term,
      termReplacer: async () => expandOperator(term, (await api.list(me, 0, 500)).messages),
    });
  }

  await addTrackedNavItem(sdk);
}

/**
 * InboxSDK attaches nav items to Gmail's `.aeN` sidebar and gives up with "should not happen"
 * when it is not rendered yet, which happens on soft reloads.
 */
async function addTrackedNavItem(sdk: InboxSDK.InboxSDK) {
  const descriptor = {
    name: "Tracked",
    iconUrl: chrome.runtime.getURL("icons/opened.svg"),
    routeID: TRACKED_ROUTE,
    orderHint: 0,
  };
  for (let attempt = 0; attempt < 20; attempt++) {
    const item = sdk.NavMenu.addNavItem(descriptor);
    let element: HTMLElement;
    try {
      element = await item.getElement();
    } catch (err) {
      item.remove();
      log("gave up adding the Tracked nav item", err);
      return;
    }
    if (element.isConnected) return;
    item.remove();
    log("nav item did not attach, retrying");
    await new Promise((r) => setTimeout(r, 500));
  }
  log("gave up adding the Tracked nav item");
}

main().catch((err) => log(err));
