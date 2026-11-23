export type Settings = {
  serverUrl: string;
  apiKey: string;
  undoDelaySec: number;
};

export const DEFAULT_UNDO_DELAY_SEC = 5;

export async function loadSettings(): Promise<Settings | null> {
  const s = (await chrome.storage.sync.get(["serverUrl", "apiKey", "undoDelaySec"])) as Partial<Settings>;
  if (!s.serverUrl || !s.apiKey) return null;
  const undoDelaySec = typeof s.undoDelaySec === "number" && s.undoDelaySec >= 0 ? s.undoDelaySec : DEFAULT_UNDO_DELAY_SEC;
  return { serverUrl: s.serverUrl.replace(/\/$/, ""), apiKey: s.apiKey, undoDelaySec };
}

export async function saveSettings(s: Partial<Settings> & { serverUrl: string; apiKey: string }) {
  await chrome.storage.sync.set({
    serverUrl: s.serverUrl.replace(/\/$/, ""),
    apiKey: s.apiKey,
    undoDelaySec: typeof s.undoDelaySec === "number" ? s.undoDelaySec : DEFAULT_UNDO_DELAY_SEC,
  });
}
