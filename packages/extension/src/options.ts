import { createApi } from "./api.js";
import { DEFAULT_UNDO_DELAY_SEC, loadSettings, saveSettings } from "./settings.js";
import { installPixelBlockRule } from "./tracking.js";

const $ = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T;

function setMessage(el: HTMLElement, text: string, ok = true) {
  el.textContent = text;
  el.className = `status ${ok ? "ok" : "err"}`;
}

async function refreshAccounts() {
  const list = $<HTMLUListElement>("accounts");
  const statusEl = $("accountStatus");
  const settings = await loadSettings();
  if (!settings) {
    list.innerHTML = "";
    setMessage(statusEl, "Save your Server URL and API key first.", false);
    return;
  }
  $("redirectUri").textContent = `${settings.serverUrl}/auth/google/callback`;
  try {
    const api = createApi(settings);
    const { accounts, hasServerGoogleClient } = await api.accounts();
    $("oauthClientFields").hidden = hasServerGoogleClient;
    list.replaceChildren();
    if (accounts.length === 0) {
      const li = document.createElement("li");
      li.textContent = "No accounts connected yet.";
      list.append(li);
      setMessage(statusEl, "");
      return;
    }
    for (const acc of accounts) {
      const li = document.createElement("li");
      const info = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = acc.email;
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.style.marginLeft = "8px";
      badge.textContent = acc.authType === "oauth" ? "OAuth" : "App Password";
      info.append(strong, badge);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Disconnect";
      btn.addEventListener("click", async () => {
        try {
          await api.disconnectAccount(acc.email);
          setMessage(statusEl, `Disconnected ${acc.email}`);
          await refreshAccounts();
        } catch (err) {
          setMessage(statusEl, (err as Error).message, false);
        }
      });
      li.append(info, btn);
      list.append(li);
    }
    setMessage(statusEl, "");
  } catch (err) {
    setMessage(statusEl, `Could not reach server: ${(err as Error).message}`, false);
  }
}

function applyServerSettingsToForm(s: Awaited<ReturnType<ReturnType<typeof createApi>["getServerSettings"]>>) {
  const webhookInput = $<HTMLInputElement>("discordWebhook");
  webhookInput.value = "";
  webhookInput.placeholder = s.discordWebhookConfigured
    ? `Configured (${s.discordWebhookMasked ?? "saved"}) — paste new URL to replace`
    : "https://discord.com/api/webhooks/...";
  $<HTMLInputElement>("notifyFirstOpen").checked = s.notifyFirstOpen;
  $<HTMLInputElement>("notifyHotSpike").checked = s.notifyHotSpike;
  $<HTMLInputElement>("notifyRevival").checked = s.notifyRevival;
  $<HTMLInputElement>("notifyBounce").checked = s.notifyBounce;
  $<HTMLInputElement>("digestEnabled").checked = s.digestEnabled;
  $<HTMLInputElement>("digestHour").value = String(s.digestHour);
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  $<HTMLInputElement>("digestTimezone").value = s.digestTimezone || browserTz;
  $<HTMLTextAreaElement>("ignoredIps").value = s.ignoredIps.join("\n");
}

async function refreshServerSettings() {
  const statusEl = $("alertsStatus");
  const settings = await loadSettings();
  if (!settings) return;
  try {
    const api = createApi(settings);
    const serverSettings = await api.getServerSettings();
    applyServerSettingsToForm(serverSettings);
    setMessage(statusEl, "");
  } catch (err) {
    setMessage(statusEl, `Could not load alert settings: ${(err as Error).message}`, false);
  }
}

loadSettings().then((s) => {
  if (!s) return;
  $("serverUrl").value = s.serverUrl;
  $("apiKey").value = s.apiKey;
  $("undoDelaySec").value = String(s.undoDelaySec ?? DEFAULT_UNDO_DELAY_SEC);
  void refreshAccounts();
  void refreshServerSettings();
});

$("save").addEventListener("click", async () => {
  const serverUrl = $("serverUrl").value.trim();
  const apiKey = $("apiKey").value.trim();
  const undoDelaySec = Number($("undoDelaySec").value);
  try {
    new URL(serverUrl);
  } catch {
    setMessage($("status"), "Server URL must be a full URL", false);
    return;
  }
  if (!Number.isFinite(undoDelaySec) || undoDelaySec < 0 || undoDelaySec > 60) {
    setMessage($("status"), "Undo delay must be between 0 and 60 seconds", false);
    return;
  }
  await saveSettings({ serverUrl, apiKey, undoDelaySec });
  await installPixelBlockRule(serverUrl);
  setMessage($("status"), "Saved");
  await refreshAccounts();
  await refreshServerSettings();
});

$("connectOAuth").addEventListener("click", async () => {
  const statusEl = $("accountStatus");
  const settings = await loadSettings();
  if (!settings) return setMessage(statusEl, "Save server settings first.", false);
  try {
    setMessage(statusEl, "Starting Google OAuth…");
    const api = createApi(settings);
    const { authUrl } = await api.startOAuth({
      clientId: $("oauthClientId").value.trim() || undefined,
      clientSecret: $("oauthClientSecret").value.trim() || undefined,
      emailHint: $("oauthEmail").value.trim() || undefined,
      displayName: $("oauthName").value.trim() || undefined,
    });
    window.open(authUrl, "_blank", "noopener");
    setMessage(statusEl, "Finish signing in on the opened tab, then reopen or refresh options.");
  } catch (err) {
    setMessage(statusEl, (err as Error).message, false);
  }
});

$("connectAppPass").addEventListener("click", async () => {
  const statusEl = $("accountStatus");
  const settings = await loadSettings();
  if (!settings) return setMessage(statusEl, "Save server settings first.", false);
  const email = $("apEmail").value.trim();
  const appPassword = $("apPassword").value.trim();
  const displayName = $("apName").value.trim() || undefined;
  if (!email || !appPassword) return setMessage(statusEl, "Email and App Password are required.", false);
  try {
    setMessage(statusEl, "Verifying SMTP and IMAP…");
    const api = createApi(settings);
    await api.connectAppPassword({ email, appPassword, displayName });
    $("apPassword").value = "";
    setMessage(statusEl, `Connected ${email}`);
    await refreshAccounts();
  } catch (err) {
    setMessage(statusEl, (err as Error).message, false);
  }
});

$("saveServerSettings").addEventListener("click", async () => {
  const statusEl = $("alertsStatus");
  const settings = await loadSettings();
  if (!settings) return setMessage(statusEl, "Save server settings first.", false);
  const webhookRaw = $<HTMLInputElement>("discordWebhook").value.trim();
  const digestHour = Number($<HTMLInputElement>("digestHour").value);
  if (!Number.isInteger(digestHour) || digestHour < 0 || digestHour > 23) {
    return setMessage(statusEl, "Digest hour must be an integer from 0 to 23.", false);
  }
  const digestTimezone = $<HTMLInputElement>("digestTimezone").value.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const ignoredIps = $<HTMLTextAreaElement>("ignoredIps")
    .value.split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  try {
    const api = createApi(settings);
    const updated = await api.updateServerSettings({
      ...(webhookRaw ? { discordWebhookUrl: webhookRaw } : {}),
      notifyFirstOpen: $<HTMLInputElement>("notifyFirstOpen").checked,
      notifyHotSpike: $<HTMLInputElement>("notifyHotSpike").checked,
      notifyRevival: $<HTMLInputElement>("notifyRevival").checked,
      notifyBounce: $<HTMLInputElement>("notifyBounce").checked,
      digestEnabled: $<HTMLInputElement>("digestEnabled").checked,
      digestHour,
      digestTimezone,
      ignoredIps,
    });
    applyServerSettingsToForm(updated);
    setMessage(statusEl, "Saved alert settings.");
  } catch (err) {
    setMessage(statusEl, (err as Error).message, false);
  }
});

$("clearWebhook").addEventListener("click", async () => {
  const statusEl = $("alertsStatus");
  const settings = await loadSettings();
  if (!settings) return setMessage(statusEl, "Save server settings first.", false);
  try {
    const api = createApi(settings);
    const updated = await api.updateServerSettings({ discordWebhookUrl: "" });
    applyServerSettingsToForm(updated);
    setMessage(statusEl, "Discord webhook cleared.");
  } catch (err) {
    setMessage(statusEl, (err as Error).message, false);
  }
});

$("testDiscord").addEventListener("click", async () => {
  const statusEl = $("alertsStatus");
  const settings = await loadSettings();
  if (!settings) return setMessage(statusEl, "Save server settings first.", false);
  const webhookRaw = $<HTMLInputElement>("discordWebhook").value.trim();
  try {
    setMessage(statusEl, "Sending test alert…");
    const api = createApi(settings);
    await api.sendTestNotification(webhookRaw || undefined);
    setMessage(statusEl, "Test alert sent to Discord.");
  } catch (err) {
    setMessage(statusEl, (err as Error).message, false);
  }
});

$("sendDigest").addEventListener("click", async () => {
  const statusEl = $("alertsStatus");
  const settings = await loadSettings();
  if (!settings) return setMessage(statusEl, "Save server settings first.", false);
  try {
    setMessage(statusEl, "Sending digest…");
    const api = createApi(settings);
    await api.sendDigestNow();
    setMessage(statusEl, "Daily digest sent to Discord.");
  } catch (err) {
    setMessage(statusEl, (err as Error).message, false);
  }
});
