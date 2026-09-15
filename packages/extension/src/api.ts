import type { Settings } from "./settings.js";

export type Registration = { id: string; sender: string; recipients: string[]; subject: string };
export type OpenSummary = { opens: number; firstOpenAt: number | null; lastOpenAt: number | null; openAts: number[] };
export type ThreadSummary = { tracked: number; opens: number; lastOpenAt: number | null };
export type Status = { messages: Record<string, OpenSummary>; threads: Record<string, ThreadSummary> };

export function createApi(settings: Settings) {
  async function call(path: string, method: string, body?: unknown) {
    const res = await fetch(`${settings.serverUrl}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${settings.apiKey}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`open-mailtrack ${method} ${path}: HTTP ${res.status}`);
    return res;
  }

  return {
    register: (r: Registration) => call("/messages", "POST", { ...r, source: "extension" }),
    markSent: (id: string, gmailMessageId: string, gmailThreadId: string) =>
      call(`/messages/${id}`, "PATCH", { gmailMessageId, gmailThreadId }),
    view: (gmailMessageId: string) => call("/views", "POST", { gmailMessageId }),
    status: async (messageIds: string[], threadIds: string[]): Promise<Status> => {
      const q = new URLSearchParams({ messageIds: messageIds.join(","), threadIds: threadIds.join(",") });
      return (await call(`/status?${q}`, "GET")).json();
    },
  };
}

/** Coalesces status lookups fired by many rows rendering at once into one request. */
export function createStatusBatcher(api: ReturnType<typeof createApi>, delayMs = 150) {
  let messageIds = new Map<string, ((s: OpenSummary | undefined) => void)[]>();
  let threadIds = new Map<string, ((s: ThreadSummary | undefined) => void)[]>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function flush() {
    timer = null;
    const m = messageIds;
    const t = threadIds;
    messageIds = new Map();
    threadIds = new Map();
    try {
      const status = await api.status([...m.keys()], [...t.keys()]);
      m.forEach((cbs, id) => cbs.forEach((cb) => cb(status.messages[id])));
      t.forEach((cbs, id) => cbs.forEach((cb) => cb(status.threads[id])));
    } catch (err) {
      console.log("[open-mailtrack]", err);
    }
  }
  const schedule = () => (timer ??= setTimeout(flush, delayMs));

  return {
    message: (id: string) =>
      new Promise<OpenSummary | undefined>((resolve) => {
        messageIds.set(id, [...(messageIds.get(id) ?? []), resolve]);
        schedule();
      }),
    thread: (id: string) =>
      new Promise<ThreadSummary | undefined>((resolve) => {
        threadIds.set(id, [...(threadIds.get(id) ?? []), resolve]);
        schedule();
      }),
  };
}
