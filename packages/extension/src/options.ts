import { loadSettings, saveSettings } from "./settings.js";
import { pixelBlockRule } from "./tracking.js";

const $ = (id: string) => document.getElementById(id) as HTMLInputElement;

loadSettings().then((s) => {
  if (!s) return;
  $("serverUrl").value = s.serverUrl;
  $("apiKey").value = s.apiKey;
});

$("save").addEventListener("click", async () => {
  const serverUrl = $("serverUrl").value.trim();
  const apiKey = $("apiKey").value.trim();
  try {
    new URL(serverUrl);
  } catch {
    $("status").textContent = "Server URL must be a full URL";
    return;
  }
  await saveSettings({ serverUrl, apiKey });
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: [pixelBlockRule(serverUrl)],
  });
  $("status").textContent = "Saved";
});
