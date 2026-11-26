import type { Settings } from "./settings.js";

export type Registration = { id: string; sender: string; recipients: string[]; subject: string };
export type Late = { kind: "after_send" | "after_previous"; days: number } | null;

export type OpenEvent = { at: number; client: string | null };

export type OpenSummary = {
  opens: number;
  firstOpenAt: number | null;
  lastOpenAt: number | null;
  openAts: number[];
  openEvents?: OpenEvent[];
  late: Late;
  appleMpp?: number;
  firstAppleMppAt?: number | null;
  lastAppleMppAt?: number | null;
  appleMppAts?: number[];
  trackingMode?: "legacy" | "per_recipient";
  recipientSummaries?: RecipientOpenSummary[];
};

export type RecipientOpenSummary = {
  recipient: string;
  kind: "to" | "cc" | "bcc";
  opens: number;
  firstOpenAt: number | null;
  lastOpenAt: number | null;
  openAts: number[];
  openEvents?: OpenEvent[];
  late: Late;
  appleMpp?: number;
  firstAppleMppAt?: number | null;
  lastAppleMppAt?: number | null;
  appleMppAts?: number[];
};

export type TrackedMessage = OpenSummary & {
  id: string;
  subject: string;
  recipients: string[];
  gmail_thread_id: string | null;
  sent_at: number | null;
  created_at: number;
  replied_at?: number | null;
  followup_dismissed_at?: number | null;
  bounced_at?: number | null;
  bounce_reason?: string | null;
};

export type ServerSettings = {
  discordWebhookConfigured: boolean;
  discordWebhookMasked: string | null;
  notifyFirstOpen: boolean;
  notifyHotSpike: boolean;
  notifyRevival: boolean;
  notifyBounce: boolean;
  digestEnabled: boolean;
  digestHour: number;
  digestTimezone: string;
  ignoredIps: string[];
};

export type ServerSettingsPatch = Partial<Omit<ServerSettings, "discordWebhookConfigured" | "discordWebhookMasked">> & {
  discordWebhookUrl?: string;
};

export type ThreadSummary = {
  tracked: number;
  opens: number;
  lastOpenAt: number | null;
  late: Late;
  appleMpp?: number;
  lastAppleMppAt?: number | null;
  recipientCount?: number;
  openedRecipients?: number;
  openedRecipientEmails?: string[];
};

export type Status = { messages: Record<string, OpenSummary>; threads: Record<string, ThreadSummary> };

export type ConnectedAccount = {
  email: string;
  authType: "oauth" | "app_password";
  displayName: string | null;
  connectedAt: number;
  updatedAt: number;
};

export type AccountsResponse = {
  accounts: ConnectedAccount[];
  hasServerGoogleClient: boolean;
};

export type OutboxEnqueueRequest = {
  sender: string;
  from?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html: string;
  text?: string;
  threadId?: string | null;
  draftId?: string | null;
  draftMessageId?: string | null;
  hasAttachments?: boolean;
  expectedAttachmentCount?: number;
  allowDuplicate?: boolean;
  clientRequestId?: string;
  sendAt?: number;
  undoDelayMs?: number;
  isScheduled?: boolean;
  cancelOnReply?: boolean;
};

export type OutboxEnqueueResponse = {
  outboxId: string;
  messageId: string;
  sendAt: number;
  remainingMs?: number;
  status: "queued" | "sent" | "canceled";
};

export type OutboxItem = {
  id: string;
  accountEmail: string;
  messageId: string;
  status: "queued" | "sending" | "sent" | "canceled" | "failed";
  sendAt: number;
  isScheduled: boolean;
  cancelOnReply?: boolean;
  subject: string;
  recipients: { to: string[]; cc: string[]; bcc: string[] };
  threadId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ContactSummary = {
  email: string;
  messages: number;
  attributableMessages: number;
  openedMessages: number;
  appleMppMessages: number;
  totalOpens: number;
  lastOpenAt: number | null;
  lastSentAt: number | null;
};

export type ContactMessageEntry = {
  id: string;
  subject: string;
  recipients: string[];
  gmail_thread_id: string | null;
  sent_at: number | null;
  created_at: number;
  attribution: "individual" | "group_unknown";
  opens: number;
  firstOpenAt: number | null;
  lastOpenAt: number | null;
  openAts: number[];
  late: Late;
  appleMpp: number;
  lastAppleMppAt: number | null;
  appleMppAts: number[];
};

export function createApi(settings: Pick<Settings, "serverUrl" | "apiKey">) {
  async function call(path: string, method: string, body?: unknown) {
    const res = await fetch(`${settings.serverUrl}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${settings.apiKey}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = "";
      try {
        const err = (await res.json()) as { error?: string };
        if (err.error) detail = `: ${err.error}`;
      } catch {
        // ignore non-json errors
      }
      throw new Error(`open-mailtrack ${method} ${path} (HTTP ${res.status})${detail}`);
    }
    return res;
  }

  return {
    register: (r: Registration) => call("/messages", "POST", { ...r, source: "extension" }),
    markSent: (id: string, gmailMessageId: string, gmailThreadId: string) =>
      call(`/messages/${id}`, "PATCH", { gmailMessageId, gmailThreadId }),
    recoverLink: (id: string, gmailMessageId: string, gmailThreadId: string, sender: string) =>
      call(`/messages/${id}/recover`, "PATCH", { gmailMessageId, gmailThreadId, sender }),
    view: (gmailMessageId: string) => call("/views", "POST", { gmailMessageId }),
    status: async (messageIds: string[], threadIds: string[]): Promise<Status> => {
      const q = new URLSearchParams({ messageIds: messageIds.join(","), threadIds: threadIds.join(",") });
      return (await call(`/status?${q}`, "GET")).json();
    },
    list: async (sender: string, offset: number, limit: number): Promise<{ total: number; messages: TrackedMessage[] }> => {
      const q = new URLSearchParams({ sender, offset: String(offset), limit: String(limit) });
      return (await call(`/messages?${q}`, "GET")).json();
    },

    // Accounts
    accounts: async (): Promise<AccountsResponse> => (await call("/accounts", "GET")).json(),
    startOAuth: async (body: { clientId?: string; clientSecret?: string; emailHint?: string; displayName?: string }): Promise<{ authUrl: string }> =>
      (await call("/accounts/oauth/start", "POST", body)).json(),
    connectAppPassword: async (body: { email: string; appPassword: string; displayName?: string }): Promise<{ account: ConnectedAccount }> =>
      (await call("/accounts/app-password", "POST", body)).json(),
    disconnectAccount: (email: string) => call(`/accounts/${encodeURIComponent(email)}`, "DELETE"),

    // Unified Outbox (Undo Send + Schedule Send)
    enqueueOutbox: async (req: OutboxEnqueueRequest): Promise<OutboxEnqueueResponse> =>
      (await call("/outbox", "POST", req)).json(),
    listOutbox: async (sender: string): Promise<{ items: OutboxItem[] }> => {
      const q = new URLSearchParams({ sender });
      return (await call(`/outbox?${q}`, "GET")).json();
    },
    cancelOutbox: async (id: string, restoreDraft = true): Promise<{ canceled: boolean; draftId: string | null; draftMessageId: string | null }> =>
      (await call(`/outbox/${encodeURIComponent(id)}?restoreDraft=${restoreDraft}`, "DELETE")).json(),
    rescheduleOutbox: async (id: string, sendAt: number): Promise<{ outboxId: string; sendAt: number; status: string }> =>
      (await call(`/outbox/${encodeURIComponent(id)}`, "PATCH", { sendAt })).json(),

    // Contacts
    listContacts: async (sender: string, q = ""): Promise<{ total: number; contacts: ContactSummary[] }> => {
      const params = new URLSearchParams({ sender });
      if (q) params.set("q", q);
      return (await call(`/contacts?${params}`, "GET")).json();
    },
    getContact: async (email: string, sender: string): Promise<{ contact: ContactSummary; messages: ContactMessageEntry[] }> => {
      const params = new URLSearchParams({ sender });
      return (await call(`/contacts/${encodeURIComponent(email)}?${params}`, "GET")).json();
    },

    // Follow-up & reply checks
    dismissFollowup: (id: string, dismissed = true) =>
      call(`/messages/${encodeURIComponent(id)}/dismiss-followup`, "POST", { dismissed }),
    refreshFollowups: async (sender: string): Promise<{ checked: number; replied: number; bounced?: number }> =>
      (await call("/followups/refresh", "POST", { sender, force: true })).json(),

    // Server settings & Discord notifications
    getServerSettings: async (): Promise<ServerSettings> => (await call("/settings", "GET")).json(),
    updateServerSettings: async (patch: ServerSettingsPatch): Promise<ServerSettings> =>
      (await call("/settings", "PATCH", patch)).json(),
    sendTestNotification: async (discordWebhookUrl?: string): Promise<{ ok: boolean }> =>
      (await call("/notifications/test", "POST", discordWebhookUrl ? { discordWebhookUrl } : {})).json(),
    sendDigestNow: async (): Promise<{ ok: boolean }> =>
      (await call("/notifications/digest", "POST", {})).json(),
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
      m.forEach((cbs) => cbs.forEach((cb) => cb(undefined)));
      t.forEach((cbs) => cbs.forEach((cb) => cb(undefined)));
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
