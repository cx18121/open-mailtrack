export type Settings = { serverUrl: string; apiKey: string };

export async function loadSettings(): Promise<Settings | null> {
  const s = (await chrome.storage.sync.get(["serverUrl", "apiKey"])) as Partial<Settings>;
  return s.serverUrl && s.apiKey ? { serverUrl: s.serverUrl.replace(/\/$/, ""), apiKey: s.apiKey } : null;
}

export async function saveSettings(s: Settings) {
  await chrome.storage.sync.set({ serverUrl: s.serverUrl.replace(/\/$/, ""), apiKey: s.apiKey });
}
