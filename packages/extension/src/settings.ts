export type Settings = { serverUrl: string; apiKey: string };

export async function loadSettings(): Promise<Settings | null> {
  const s = (await chrome.storage.sync.get(["serverUrl", "apiKey"])) as Partial<Settings>;
  return s.serverUrl && s.apiKey ? { serverUrl: s.serverUrl.replace(/\/$/, ""), apiKey: s.apiKey } : null;
}

export async function saveSettings(s: Settings) {
  await chrome.storage.sync.set({ serverUrl: s.serverUrl.replace(/\/$/, ""), apiKey: s.apiKey });
}

export type TrackedState = { bucket: "follow_up" | "unopened" | "recent" | "replied" | "all"; quietDays: number };

export async function loadTrackedState(): Promise<TrackedState> {
  const s = (await chrome.storage.sync.get(["trackedBucket", "quietDays"])) as { trackedBucket?: TrackedState["bucket"]; quietDays?: number };
  return { bucket: s.trackedBucket ?? "follow_up", quietDays: s.quietDays ?? 3 };
}

export async function saveTrackedState(state: TrackedState) {
  await chrome.storage.sync.set({ trackedBucket: state.bucket, quietDays: state.quietDays });
}
