import * as InboxSDK from "@inboxsdk/core";
import Kefir from "kefir";
import { createApi, createStatusBatcher } from "./api.js";
import { icon, label } from "./marks.js";
import { loadSettings } from "./settings.js";
import { createPixel, newId, PIXEL_ATTR, removePixels } from "./tracking.js";

const APP_ID = "sdk_openmt_62266805c2";
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
    api.view(messageId).catch((err) => log(err));
    const summary = await status.message(messageId);
    if (summary) message.addAttachmentIcon(icon(summary));
  });

  sdk.Lists.registerThreadRowViewHandler(async (row) => {
    const threadId = await row.getThreadIDAsync();
    const summary = await status.thread(threadId);
    if (summary) row.addLabel(label(summary));
  });
}

main().catch((err) => log(err));
