import "@inboxsdk/core/background.js";
import { loadSettings } from "./settings.js";
import { installPixelBlockRule } from "./tracking.js";

// Dynamic rules survive extension updates. Replace the old direct-only rule on update or reload.
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const settings = await loadSettings();
    if (settings) await installPixelBlockRule(settings.serverUrl);
  } catch (err) {
    console.error("[open-mailtrack] pixel blocking setup failed", err);
  }
});
