import * as InboxSDK from "@inboxsdk/core";
import { createApi } from "./api.js";
import { loadSettings } from "./settings.js";
import { createPixel, newId, PIXEL_ATTR } from "./tracking.js";

const APP_ID = "open-mailtrack";
const log = (...args: unknown[]) => console.log("[open-mailtrack]", ...args);

async function main() {
  const settings = await loadSettings();
  if (!settings) {
    log("not configured; open the extension options");
    return;
  }
  const api = createApi(settings);
  const sdk = await InboxSDK.load(2, APP_ID);
  const me = sdk.User.getEmailAddress().toLowerCase();

  sdk.Compose.registerComposeViewHandler((compose) => {
    let pixel: HTMLImageElement | null = null;

    compose.on("presending", () => {
      const recipients = [...compose.getToRecipients(), ...compose.getCcRecipients(), ...compose.getBccRecipients()]
        .map((c) => c.emailAddress.toLowerCase());
      if (recipients.length === 0 || recipients.every((r) => r === me)) return;

      const body = compose.getBodyElement();
      body.querySelectorAll(`img[${PIXEL_ATTR}]`).forEach((el) => el.remove());
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

  sdk.Conversations.registerThreadViewHandler(async (thread) => {
    const threadId = await thread.getThreadIDAsync();
    api.selfView(threadId).catch((err) => log(err));
  });
}

main().catch((err) => log(err));
