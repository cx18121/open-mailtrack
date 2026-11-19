import * as InboxSDK from "@inboxsdk/core";
import Kefir from "kefir";
import { createApi, createStatusBatcher, type ThreadSummary, type TrackedMessage } from "./api.js";
import { messageSearch, ownPixelId } from "./link.js";
import { rowImage, statusElement } from "./marks.js";
import { expandOperator, OPERATORS } from "./search.js";
import { trackedList, type Filter } from "./tracked.js";
import { loadSettings } from "./settings.js";
import { createPixel, hasPixel, newId, removePixels } from "./tracking.js";

const APP_ID = "sdk_openmt_62266805c2";
const TRACKED_ROUTE = "tracked";
const REFRESH_MS = 30_000;
const log = (...args: unknown[]) => console.log("[open-mailtrack]", ...args);

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

  /** Emits immediately for each subscriber and then every REFRESH_MS while the page is visible. */
  const ticks = Kefir.interval(REFRESH_MS, null)
    .filter(() => document.visibilityState === "visible")
    .toProperty(() => null);

  sdk.Compose.registerComposeViewHandler((compose) => {
    let pixel: HTMLImageElement | null = null;
    let pending: { id: string; registered: Promise<boolean> } | null = null;
    let enabled = true;

    const toggle = Kefir.pool<boolean, unknown>();
    compose.addButton(
      toggle.toProperty(() => enabled).map((on) => ({
        title: on ? "Tracking on" : "Tracking off",
        tooltip: on ? "Open tracking is on for this message. Click to turn off." : "Open tracking is off for this message. Click to turn on.",
        iconUrl: chrome.runtime.getURL(on ? "icons/track-on.svg" : "icons/track-off.svg"),
        type: "MODIFIER" as const,
        orderHint: 0,
        onClick: () => {
          enabled = !enabled;
          toggle.plug(Kefir.constant(enabled));
        },
      })),
    );

    compose.on("presending", () => {
      if (!enabled) return;
      const recipients = [...compose.getToRecipients(), ...compose.getCcRecipients(), ...compose.getBccRecipients()]
        .map((c) => c.emailAddress.toLowerCase());
      if (recipients.length === 0 || recipients.every((r) => r === me)) return;

      const body = compose.getBodyElement();
      removePixels(body, settings.serverUrl);
      const id = newId();
      pixel = createPixel(body.ownerDocument, settings.serverUrl, id);
      body.appendChild(pixel);
      const registration = { id, sender: me, recipients, subject: compose.getSubject() };
      pending = {
        id,
        registered: api.register(registration).then(() => true, (err) => { log(err); return false; }),
      };
      log("tracking", id, recipients);
    });

    compose.on("sendCanceled", () => {
      pixel?.remove();
      pixel = null;
      pending = null;
    });

    compose.on("sent", async (event) => {
      const sent = pending;
      pending = null;
      pixel = null;
      if (!sent) return;
      try {
        const [registered, messageId, threadId] = await Promise.all([
          sent.registered, event.getMessageID(), event.getThreadID(),
        ]);
        if (!registered) return;
        await api.markSent(sent.id, messageId, threadId);
        log("sent", sent.id, messageId, threadId);
      } catch (err) {
        // The sent body still carries the pixel ID, so opening it can recover the link later.
        log("could not link sent message", err);
      }
    });
  });

  sdk.Conversations.registerMessageViewHandler(async (message) => {
    if (message.getSender().emailAddress.toLowerCase() !== me) return;
    const messageId = await message.getMessageIDAsync();
    const reportView = () => api.view(messageId).catch((err) => log(err));
    reportView();
    // Gmail reloads a message's images whenever it re-renders the thread (send completing, new mail,
    // label changes). Report a view each time our pixel is inserted so those fetches stay classified as ours.
    const observer = new MutationObserver((records) => {
      if (records.some((r) => [...r.addedNodes].some((n) => n instanceof Element && hasPixel(n, settings.serverUrl)))) reportView();
    });
    observer.observe(message.getElement(), { childList: true, subtree: true });
    message.on("destroy", () => observer.disconnect());

    let current: HTMLElement | null = null;
    const stop = Kefir.fromEvents<void, unknown>(message, "destroy");
    ticks
      .takeUntilBy(stop)
      .flatMapLatest(() => Kefir.fromPromise((async () => {
        const summary = await status.message(messageId);
        if (summary) return summary;
        const id = ownPixelId(message.getBodyElement(), settings.serverUrl, (img) => message.isElementInQuotedArea(img));
        if (!id) return;
        try {
          const threadId = await message.getThreadView().getThreadIDAsync();
          await api.recoverLink(id, messageId, threadId, me);
          return await status.message(messageId);
        } catch (err) {
          log("could not recover message link", err);
        }
      })()))
      .onValue((summary) => {
        if (!summary) return;
        const body = message.getBodyElement();
        const next = statusElement(body.ownerDocument, summary);
        if (current) current.replaceWith(next);
        else body.parentElement?.insertBefore(next, body);
        current = next;
      });
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
    let filter: Filter = "all";
    let messages: TrackedMessage[] = [];
    const draw = () =>
      el.replaceChildren(
        trackedList(
          doc,
          messages,
          filter,
          (next) => {
            filter = next;
            draw();
          },
          (message) => {
            const navigation = message.gmail_thread_id
              ? sdk.Router.goto(sdk.Router.NativeRouteIDs.THREAD, { threadID: message.gmail_thread_id })
              : sdk.Router.goto(sdk.Router.NativeRouteIDs.SEARCH, { query: messageSearch(message) });
            navigation.catch((err) => log("could not open tracked message", err));
          },
        ),
      );
    const render = async () => {
      try {
        ({ messages } = await api.list(me, 0, 500));
        if (!alive) return;
        draw();
      } catch (err) {
        log("tracked list failed", err);
        if (alive) note("Could not load tracked messages.");
      }
    };
    void render();
    const timer = setInterval(() => document.visibilityState === "visible" && render(), REFRESH_MS);
    route.on("destroy", () => {
      alive = false;
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
 * when it is not rendered yet, which happens on soft reloads. InboxSDK first waits for the sidebar,
 * which can take seconds, so wait for each attempt to settle, and remove a detached item before
 * retrying so only one Tracked item can exist.
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
      // Resolves after InboxSDK has tried to attach the item.
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
