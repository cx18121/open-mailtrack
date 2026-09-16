import * as InboxSDK from "@inboxsdk/core";
import Kefir from "kefir";
import { createApi, createStatusBatcher, type ThreadSummary } from "./api.js";
import { rowImage, statusElement } from "./marks.js";
import { trackedList } from "./tracked.js";
import { loadSettings } from "./settings.js";
import { createPixel, hasPixel, newId, PIXEL_ATTR, removePixels } from "./tracking.js";

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
      api.register({ id, sender: me, recipients, subject: compose.getSubject() }).catch((err) => log(err));
      log("tracking", id, recipients);
    });

    compose.on("sendCanceled", () => {
      pixel?.remove();
      pixel = null;
    });

    compose.on("sent", async (event) => {
      const id = pixel?.getAttribute(PIXEL_ATTR);
      pixel = null;
      if (!id) return;
      const [messageId, threadId] = await Promise.all([event.getMessageID(), event.getThreadID()]);
      api.markSent(id, messageId, threadId).catch((err) => log(err));
      log("sent", id, messageId, threadId);
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
      .flatMapLatest(() => Kefir.fromPromise(status.message(messageId)))
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
    const render = async () => {
      try {
        const { messages } = await api.list(0, 200);
        if (!alive) return;
        el.replaceChildren(
          trackedList(doc, messages, (threadId) => sdk.Router.goto(sdk.Router.NativeRouteIDs.THREAD, { threadID: threadId })),
        );
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

  await addTrackedNavItem(sdk);
}

/**
 * InboxSDK attaches nav items to Gmail's `.aeN` sidebar and gives up with "should not happen"
 * when it is not rendered yet, which happens on soft reloads. Wait for it and verify the item landed.
 */
async function addTrackedNavItem(sdk: InboxSDK.InboxSDK) {
  const descriptor = {
    name: "Tracked",
    iconUrl: chrome.runtime.getURL("icons/opened.svg"),
    routeID: TRACKED_ROUTE,
    orderHint: 0,
  };
  const sidebarReady = () => document.querySelector(".aeN[role=navigation], .aeN [role=navigation]");
  for (let attempt = 0; attempt < 20; attempt++) {
    if (sidebarReady()) {
      sdk.NavMenu.addNavItem(descriptor);
      await new Promise((r) => setTimeout(r, 1000));
      if ([...document.querySelectorAll(".inboxsdk__navItem_name")].some((el) => el.textContent === "Tracked")) return;
      log("nav item did not attach, retrying");
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  log("gave up adding the Tracked nav item");
}

main().catch((err) => log(err));
