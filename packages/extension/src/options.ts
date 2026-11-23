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

loadSettings().then((s) => {
  if (!s) return;
  $("serverUrl").value = s.serverUrl;
  $("apiKey").value = s.apiKey;
  $<HTMLSelectElement>("undoDelaySec").value = String(s.undoDelaySec ?? DEFAULT_UNDO_DELAY_SEC);
  void refreshAccounts();
});

$("save").addEventListener("click", async () => {
  const serverUrl = $("serverUrl").value.trim();
  const apiKey = $("apiKey").value.trim();
  const undoDelaySec = Number($<HTMLSelectElement>("undoDelaySec").value);
  try {
    new URL(serverUrl);
  } catch {
    setMessage($("status"), "Server URL must be a full URL", false);
    return;
  }
  await saveSettings({ serverUrl, apiKey, undoDelaySec });
  await installPixelBlockRule(serverUrl);
  setMessage($("status"), "Saved");
  await refreshAccounts();
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
