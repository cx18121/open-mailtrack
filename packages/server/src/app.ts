import { randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { createAppleRelayStore, type AppleRelayStore } from "./apple-mpp.js";
import {
  classifyHit,
  extractOpenEvents,
  summarize,
  CLASSIFIER_VERSION,
  type OpenEvent,
  type OpenSummary,
  type RecipientOpenSummary,
} from "./classify.js";
import { createCipher, type Cipher } from "./crypto.js";
import type { Account, Db, Hit, Message, RecipientToken } from "./db.js";
import {
  createAppPasswordTransport,
  createOAuthTransport,
  fetchGoogleProfileEmail,
  type AppPasswordCredentials,
  type OAuthCredentials,
} from "./mailbox.js";
import { createNotifier, type Notifier } from "./notifications.js";
import {
  createOutboxService,
  defaultTransportFactory,
  OutboxError,
  type EnqueueRequest,
  type OutboxService,
  type TransportFactory,
} from "./outbox.js";
import { createReplyChecker, type ReplyChecker } from "./replies.js";
import { createSettingsStore, isValidDiscordWebhookUrl, type ServerSettingsPatch, type SettingsStore } from "./settings.js";

const ID = /^[A-Za-z0-9_-]{22}$/;
export const newId = () => randomBytes(16).toString("base64url");

const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const GOOGLE_OAUTH_SCOPES = "https://mail.google.com/ https://www.googleapis.com/auth/userinfo.email";

export type Config = {
  apiKey: string;
  publicUrl: string;
  encryptionKey?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  discordWebhookUrl?: string;
  ignoredIps?: string[];
  digestHour?: number;
  digestTimezone?: string;
  fetchImpl?: typeof fetch;
  appleRelay?: AppleRelayStore;
  transportFactory?: TransportFactory;
  outboxPollMs?: number;
  digestCheckIntervalMs?: number;
};

export type RecipientSummaryWithEvents = RecipientOpenSummary & {
  openEvents: OpenEvent[];
};

export type MessageSummary = OpenSummary & {
  trackingMode: Message["tracking_mode"];
  openEvents: OpenEvent[];
  recipientSummaries?: RecipientSummaryWithEvents[];
};

export type ThreadSummaryResponse = {
  tracked: number;
  opens: number;
  lastOpenAt: number | null;
  late: OpenSummary["late"];
  appleMpp: number;
  lastAppleMppAt: number | null;
  recipientCount: number;
  openedRecipients: number;
  openedRecipientEmails: string[];
};

type PendingOAuthState = {
  clientId: string;
  clientSecret: string;
  displayName?: string;
  createdAt: number;
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function createApp(db: Db, config: Config) {
  const app = new Hono();
  const publicUrl = config.publicUrl.replace(/\/$/, "");
  const cipher: Cipher = createCipher(config.encryptionKey?.trim() || config.apiKey);
  const appleRelay = config.appleRelay ?? createAppleRelayStore();
  const settings: SettingsStore = createSettingsStore(db, cipher, {
    discordWebhookUrl: config.discordWebhookUrl,
    ignoredIps: config.ignoredIps,
    digestHour: config.digestHour,
    digestTimezone: config.digestTimezone,
  });
  const transportFactory = config.transportFactory ?? defaultTransportFactory;
  let notifierRef: Notifier | null = null;
  const outbox: OutboxService = createOutboxService({
    db,
    cipher,
    publicUrl,
    transportFactory,
    pollMs: config.outboxPollMs,
    onAutoCanceled: (args) => {
      void notifierRef?.notifyAutoCanceled(args).catch((err) => {
        console.error("[open-mailtrack] auto-cancel notification failed:", err);
      });
    },
  });

  type BatchContext = {
    allMessages: Message[];
    byThread: Map<string, Message[]>;
    hitsByMessage: Map<string, Hit[]>;
    tokensByMessage: Map<string, RecipientToken[]>;
    viewsByGmailMessageId: Map<string, number[]>;
  };

  const createBatchContext = (): BatchContext => {
    const allMessages = db.listMessages();
    const byThread = new Map<string, Message[]>();
    for (const m of allMessages) {
      if (!m.gmail_thread_id) continue;
      const list = byThread.get(m.gmail_thread_id) ?? [];
      list.push(m);
      byThread.set(m.gmail_thread_id, list);
    }
    const hitsByMessage = new Map<string, Hit[]>();
    for (const h of db.listAllHits()) {
      const list = hitsByMessage.get(h.message_id) ?? [];
      list.push(h);
      hitsByMessage.set(h.message_id, list);
    }
    const tokensByMessage = new Map<string, RecipientToken[]>();
    for (const t of db.listAllRecipientTokens()) {
      const list = tokensByMessage.get(t.message_id) ?? [];
      list.push(t);
      tokensByMessage.set(t.message_id, list);
    }
    const viewsByGmailMessageId = new Map<string, number[]>();
    for (const v of db.listAllViews()) {
      const list = viewsByGmailMessageId.get(v.gmail_message_id) ?? [];
      list.push(v.at);
      viewsByGmailMessageId.set(v.gmail_message_id, list);
    }
    return { allMessages, byThread, hitsByMessage, tokensByMessage, viewsByGmailMessageId };
  };

  const pendingOAuth = new Map<string, PendingOAuthState>();
  const pruneOAuth = () => {
    const cutoff = Date.now() - 15 * 60_000;
    for (const [k, v] of pendingOAuth) {
      if (v.createdAt < cutoff) pendingOAuth.delete(k);
    }
  };

  const classifyMessageHits = (
    m: Message,
    ctx?: BatchContext,
  ): { raw: Hit[]; classified: ReturnType<typeof classifyHit>[]; tokens: RecipientToken[] } => {
    // Per-recipient sends store a pixel-free copy in Sent, so sender views of Sent cannot trigger recipient pixels.
    const views =
      m.tracking_mode === "legacy" && m.gmail_message_id
        ? (ctx ? ctx.viewsByGmailMessageId.get(m.gmail_message_id) ?? [] : db.listViews(m.gmail_message_id))
        : [];
    const threadMessages = m.gmail_thread_id
      ? (ctx ? ctx.byThread.get(m.gmail_thread_id) ?? [m] : db.findByGmailThreadIds([m.gmail_thread_id]))
      : [m];
    const siblings = threadMessages.filter((t) => t.id !== m.id);
    const thread = {
      sentAts: [m, ...siblings].map((t) => t.sent_at).filter((t): t is number => t !== null),
      otherHitAts: siblings.flatMap((t) => (ctx ? ctx.hitsByMessage.get(t.id) ?? [] : db.listHits(t.id)).map((h) => h.at)),
    };
    const raw = ctx ? ctx.hitsByMessage.get(m.id) ?? [] : db.listHits(m.id);
    const tokens =
      m.tracking_mode === "per_recipient"
        ? (ctx ? ctx.tokensByMessage.get(m.id) ?? [] : db.listRecipientTokens(m.id))
        : [];
    const tokenRecipient = new Map(tokens.map((t) => [t.token, t.recipient.toLowerCase()]));
    const repliedByMap = new Map(m.replied_by.map((r) => [r.email.toLowerCase(), r.at]));

    const replyCutoffForHit = (h: Hit): number | null => {
      if (h.recipient_token) {
        const rec = tokenRecipient.get(h.recipient_token);
        if (rec && repliedByMap.has(rec)) return repliedByMap.get(rec)!;
        // Fallback for older rows with `replied_at` but no `replied_by`: safe when there is only one recipient.
        if (m.replied_by.length === 0 && tokens.length <= 1) return m.replied_at;
        return null;
      }
      if (m.recipients.length <= 1) return m.replied_at;
      return null;
    };

    const classified = raw.map((h) =>
      classifyHit(h, views, thread, {
        isAppleRelayIp: (ip) => appleRelay.has(ip),
        isIgnoredIp: (ip) => settings.isIgnoredIp(ip),
        repliedAt: replyCutoffForHit(h),
      }),
    );
    return { raw, classified, tokens };
  };

  const summaryOf = (m: Message, ctx?: BatchContext): MessageSummary => {
    const { raw, classified, tokens } = classifyMessageHits(m, ctx);
    const base = summarize(classified, m.sent_at);
    const openEvents = extractOpenEvents(classified);
    if (m.tracking_mode !== "per_recipient") {
      return { ...base, trackingMode: m.tracking_mode, openEvents };
    }
    const recipientSummaries: RecipientSummaryWithEvents[] = tokens.map((tok) => {
      const subHits = classified.filter((_, i) => raw[i].recipient_token === tok.token);
      return {
        recipient: tok.recipient,
        kind: tok.kind,
        ...summarize(subHits, m.sent_at),
        openEvents: extractOpenEvents(subHits),
      };
    });
    return { ...base, trackingMode: m.tracking_mode, openEvents, recipientSummaries };
  };

  const unsentOutboxMessageIds = () => {
    const pending = db.listOutbox({ statuses: ["queued", "sending", "canceling", "failed"] });
    return new Set(pending.map((o) => o.message_id));
  };

  const notifier: Notifier = createNotifier({
    db,
    settings,
    fetchImpl: config.fetchImpl,
    digestCheckIntervalMs: config.digestCheckIntervalMs,
    listDigestMessages: () => {
      const hidden = unsentOutboxMessageIds();
      const ctx = createBatchContext();
      return ctx.allMessages
        .filter((m) => !hidden.has(m.id))
        .map((m) => ({ ...m, ...summaryOf(m, ctx) }));
    },
  });
  notifierRef = notifier;

  const replyChecker: ReplyChecker = createReplyChecker({
    db,
    cipher,
    transportFactory,
    onBounce: (args) => {
      void notifier.notifyBounce(args).catch((err) => {
        console.error("[open-mailtrack] bounce notification failed:", err);
      });
    },
    onReply: ({ sender, threadId, repliedAt, repliedBy }) => {
      outbox.cancelQueuedForThreadReply({ accountEmail: sender, threadId, repliedAt, repliedBy });
    },
  });

  // Pixel endpoint — supports both per-recipient tokens and legacy message IDs.
  app.get("/p/:file", (c) => {
    const id = c.req.param("file").replace(/\.gif$/, "");
    if (ID.test(id)) {
      const headers: Record<string, string> = {};
      c.req.raw.headers.forEach((v, k) => (headers[k] = v));
      const ip = headers["cf-connecting-ip"] ?? headers["x-forwarded-for"]?.split(",")[0].trim() ?? null;
      const user_agent = headers["user-agent"] ?? null;
      const recipientToken = db.getRecipientToken(id);
      const messageId = recipientToken ? recipientToken.message_id : id;
      const now = Date.now();
      db.recordHit({
        message_id: messageId,
        recipient_token: recipientToken ? recipientToken.token : null,
        at: now,
        ip,
        user_agent,
        headers,
      });

      // Defer classification and Discord notification off the pixel response path.
      queueMicrotask(() => {
        try {
          const message = db.getMessage(messageId);
          if (!message) return;
          const { raw, classified } = classifyMessageHits(message);
          const latestIdx = raw.length - 1;
          const latestHit = latestIdx >= 0 ? raw[latestIdx] : null;
          const latestClassified = latestIdx >= 0 ? classified[latestIdx] : null;
          if (!latestHit || latestClassified?.kind !== "open") return;
          const scopeHits = recipientToken
            ? classified.filter((_, i) => raw[i].recipient_token === recipientToken.token)
            : classified;
          const scopeSummary = summarize(scopeHits, message.sent_at);
          void notifier
            .notifyOpen({
              message,
              summary: scopeSummary,
              recipient: recipientToken ? recipientToken.recipient : null,
              client: latestClassified.client ?? null,
              at: latestHit.at,
            })
            .catch((err) => {
              console.error("[open-mailtrack] open notification failed:", err);
            });
        } catch (err) {
          console.error("[open-mailtrack] pixel notification dispatch failed:", err);
        }
      });
    }
    return c.body(GIF, 200, {
      "Content-Type": "image/gif",
      "Content-Length": String(GIF.length),
      "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate, private",
      Pragma: "no-cache",
      Expires: "0",
    });
  });

  // Google OAuth callback (browser redirect from Google, verified by CSRF state).
  app.get("/auth/google/callback", async (c) => {
    pruneOAuth();
    const state = c.req.query("state") ?? "";
    const code = c.req.query("code") ?? "";
    const err = c.req.query("error");
    if (err) {
      return c.html(`<!doctype html><p>Google OAuth denied: ${escapeHtml(err)}</p>`, 400);
    }
    const pending = pendingOAuth.get(state);
    if (!pending || !code) {
      return c.html(`<!doctype html><p>Invalid or expired OAuth state. Start connecting again from extension options.</p>`, 400);
    }
    pendingOAuth.delete(state);

    try {
      const redirectUri = `${publicUrl}/auth/google/callback`;
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: pending.clientId,
          client_secret: pending.clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });
      const tokenBody = (await tokenRes.json()) as {
        access_token?: string;
        refresh_token?: string;
        error?: string;
        error_description?: string;
      };
      if (!tokenRes.ok || !tokenBody.access_token || !tokenBody.refresh_token) {
        throw new Error(
          `Token exchange failed: ${tokenBody.error ?? tokenRes.status} ${tokenBody.error_description ?? "missing refresh_token"}`.trim(),
        );
      }

      const email = await fetchGoogleProfileEmail(tokenBody.access_token);
      const creds: OAuthCredentials = {
        clientId: pending.clientId,
        clientSecret: pending.clientSecret,
        refreshToken: tokenBody.refresh_token,
      };
      const transport = createOAuthTransport(email, creds);
      await transport.verify();

      db.upsertAccount({
        email,
        auth_type: "oauth",
        encrypted_credentials: cipher.encrypt(JSON.stringify(creds)),
        display_name: pending.displayName ?? null,
      });

      return c.html(
        `<!doctype html><meta charset="utf-8"><body style="font:14px system-ui,sans-serif;padding:24px">` +
          `<h2>Connected ${escapeHtml(email)}</h2>` +
          `<p>Per-recipient tracking, all-device self-open immunity, and Schedule Send are now active for this account. You can close this tab and reload Gmail.</p>` +
          `</body>`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.html(
        `<!doctype html><meta charset="utf-8"><body style="font:14px system-ui,sans-serif;padding:24px">` +
          `<h2>Could not connect account</h2><p>${escapeHtml(msg)}</p>` +
          `<p>If your organization blocks unverified OAuth apps for Gmail, try connecting with a Google App Password in extension options instead.</p>` +
          `</body>`,
        400,
      );
    }
  });

  const api = new Hono();
  api.use(
    cors({
      origin: "*",
      allowHeaders: ["authorization", "content-type"],
      allowMethods: ["GET", "POST", "PATCH", "DELETE"],
    }),
  );
  api.use(async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${config.apiKey}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  // --- Accounts ---

  const publicAccount = (a: Account) => ({
    email: a.email,
    authType: a.auth_type,
    displayName: a.display_name,
    connectedAt: a.created_at,
    updatedAt: a.updated_at,
  });

  api.get("/accounts", (c) => {
    return c.json({
      accounts: db.listAccounts().map(publicAccount),
      hasServerGoogleClient: Boolean(config.googleClientId && config.googleClientSecret),
    });
  });

  api.post("/accounts/oauth/start", async (c) => {
    pruneOAuth();
    const body = await c.req.json<{
      clientId?: string;
      clientSecret?: string;
      emailHint?: string;
      displayName?: string;
    }>().catch(() => ({} as { clientId?: string; clientSecret?: string; emailHint?: string; displayName?: string }));
    const clientId = body.clientId?.trim() || config.googleClientId;
    const clientSecret = body.clientSecret?.trim() || config.googleClientSecret;
    if (!clientId || !clientSecret) {
      return c.json({ error: "clientId and clientSecret are required (or set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server)" }, 400);
    }
    const state = randomBytes(16).toString("base64url");
    pendingOAuth.set(state, { clientId, clientSecret, displayName: body.displayName?.trim(), createdAt: Date.now() });
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${publicUrl}/auth/google/callback`,
      response_type: "code",
      scope: GOOGLE_OAUTH_SCOPES,
      access_type: "offline",
      prompt: "consent",
      state,
    });
    if (body.emailHint?.trim()) params.set("login_hint", body.emailHint.trim());
    return c.json({ authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
  });

  api.post("/accounts/oauth/import", async (c) => {
    const body = await c.req.json<{
      email: string;
      clientId: string;
      clientSecret: string;
      refreshToken: string;
      displayName?: string;
      skipVerify?: boolean;
    }>();
    if (!body.email || !body.clientId || !body.clientSecret || !body.refreshToken) {
      return c.json({ error: "email, clientId, clientSecret, refreshToken required" }, 400);
    }
    const email = body.email.trim().toLowerCase();
    const creds: OAuthCredentials = {
      clientId: body.clientId.trim(),
      clientSecret: body.clientSecret.trim(),
      refreshToken: body.refreshToken.trim(),
    };
    const encrypted = cipher.encrypt(JSON.stringify(creds));
    if (!body.skipVerify) {
      try {
        const fakeAccount: Account = {
          email,
          auth_type: "oauth",
          encrypted_credentials: encrypted,
          display_name: body.displayName?.trim() ?? null,
          created_at: Date.now(),
          updated_at: Date.now(),
        };
        await transportFactory(fakeAccount, cipher).verify();
      } catch (err) {
        return c.json({ error: `OAuth verification failed: ${(err as Error).message}` }, 400);
      }
    }
    db.upsertAccount({ email, auth_type: "oauth", encrypted_credentials: encrypted, display_name: body.displayName?.trim() ?? null });
    return c.json({ account: publicAccount(db.getAccount(email)!) }, 201);
  });

  api.post("/accounts/app-password", async (c) => {
    const body = await c.req.json<{
      email: string;
      appPassword: string;
      displayName?: string;
      skipVerify?: boolean;
    }>();
    if (!body.email || !body.appPassword) {
      return c.json({ error: "email and appPassword required" }, 400);
    }
    const email = body.email.trim().toLowerCase();
    const creds: AppPasswordCredentials = { appPassword: body.appPassword.replace(/\s+/g, "") };
    const encrypted = cipher.encrypt(JSON.stringify(creds));
    if (!body.skipVerify) {
      try {
        const fakeAccount: Account = {
          email,
          auth_type: "app_password",
          encrypted_credentials: encrypted,
          display_name: body.displayName?.trim() ?? null,
          created_at: Date.now(),
          updated_at: Date.now(),
        };
        await (config.transportFactory ? config.transportFactory(fakeAccount, cipher) : createAppPasswordTransport(email, creds)).verify();
      } catch (err) {
        return c.json({ error: `App Password verification failed: ${(err as Error).message}` }, 400);
      }
    }
    db.upsertAccount({ email, auth_type: "app_password", encrypted_credentials: encrypted, display_name: body.displayName?.trim() ?? null });
    return c.json({ account: publicAccount(db.getAccount(email)!) }, 201);
  });

  api.delete("/accounts/:email", (c) => {
    const email = decodeURIComponent(c.req.param("email")).toLowerCase();
    if (!db.deleteAccount(email)) return c.json({ error: "not found" }, 404);
    return c.body(null, 204);
  });

  // --- Unified Outbox (Undo Send + Schedule Send + CLI sends) ---

  const publicOutbox = (o: ReturnType<Db["listOutbox"]>[number]) => ({
    id: o.id,
    accountEmail: o.account_email,
    messageId: o.message_id,
    status: o.status,
    sendAt: o.send_at,
    isScheduled: o.is_scheduled,
    cancelOnReply: o.cancel_on_reply,
    subject: o.subject,
    recipients: o.recipients,
    threadId: o.thread_id,
    error: o.error,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
  });

  const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
  const isOptionalString = (v: unknown): v is string | undefined => v === undefined || typeof v === "string";

  api.post("/outbox", async (c) => {
    try {
      const body = await c.req.json<EnqueueRequest>();
      if (
        typeof body.sender !== "string" ||
        !isStringArray(body.to) ||
        (body.cc !== undefined && !isStringArray(body.cc)) ||
        (body.bcc !== undefined && !isStringArray(body.bcc)) ||
        typeof body.subject !== "string" ||
        typeof body.html !== "string" ||
        !isOptionalString(body.text) ||
        !isOptionalString(body.from) ||
        !isOptionalString(body.inReplyTo) ||
        !isOptionalString(body.references) ||
        !isOptionalString(body.clientRequestId) ||
        (body.threadId !== undefined && body.threadId !== null && typeof body.threadId !== "string") ||
        (body.draftId !== undefined && body.draftId !== null && typeof body.draftId !== "string") ||
        (body.draftMessageId !== undefined && body.draftMessageId !== null && typeof body.draftMessageId !== "string") ||
        (body.cancelOnReply !== undefined && typeof body.cancelOnReply !== "boolean") ||
        (body.allowDuplicate !== undefined && typeof body.allowDuplicate !== "boolean") ||
        (body.expectedAttachmentCount !== undefined &&
          (typeof body.expectedAttachmentCount !== "number" ||
            !Number.isInteger(body.expectedAttachmentCount) ||
            body.expectedAttachmentCount < 0))
      ) {
        return c.json({ error: "invalid outbox payload" }, 400);
      }
      if (body.attachments !== undefined) {
        if (
          !Array.isArray(body.attachments) ||
          !body.attachments.every(
            (a) =>
              a &&
              typeof a === "object" &&
              typeof a.contentType === "string" &&
              typeof a.contentBase64 === "string" &&
              isOptionalString(a.filename) &&
              isOptionalString(a.cid) &&
              (a.disposition === undefined || a.disposition === "inline" || a.disposition === "attachment"),
          )
        ) {
          return c.json({ error: "invalid attachments array" }, 400);
        }
      }
      const result = await outbox.enqueue(body);
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof OutboxError) return c.json({ error: err.message }, err.status as 400 | 404 | 409 | 412 | 500 | 502);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  api.get("/outbox", (c) => {
    const sender = c.req.query("sender")?.toLowerCase();
    const statusParam = c.req.query("status");
    const statuses = statusParam
      ? (statusParam.split(",").filter(Boolean) as ("queued" | "sending" | "sent" | "canceled" | "failed")[])
      : (["queued", "sending", "failed"] as const);
    const items = db.listOutbox({ accountEmail: sender, statuses: [...statuses] }).map(publicOutbox);
    return c.json({ items });
  });

  api.get("/outbox/:id", (c) => {
    const item = db.getOutbox(c.req.param("id"));
    if (!item) return c.json({ error: "not found" }, 404);
    return c.json(publicOutbox(item));
  });

  api.delete("/outbox/:id", async (c) => {
    try {
      const restore = c.req.query("restoreDraft") !== "false";
      const result = await outbox.cancel(c.req.param("id"), restore);
      return c.json(result);
    } catch (err) {
      if (err instanceof OutboxError) return c.json({ error: err.message }, err.status as 400 | 404 | 409 | 412 | 500 | 502);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  api.patch("/outbox/:id", async (c) => {
    try {
      const body = await c.req.json<{ sendAt: number }>();
      if (typeof body.sendAt !== "number" || !Number.isFinite(body.sendAt)) {
        return c.json({ error: "sendAt timestamp required" }, 400);
      }
      const result = await outbox.reschedule(c.req.param("id"), body.sendAt);
      return c.json(result);
    } catch (err) {
      if (err instanceof OutboxError) return c.json({ error: err.message }, err.status as 400 | 404 | 409 | 412 | 500 | 502);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // --- Legacy & shared message endpoints ---

  api.post("/messages", async (c) => {
    const body = await c.req.json<{
      id?: string;
      sender: string;
      recipients: string[];
      subject: string;
      source: "extension" | "cli";
    }>();
    if (!body.sender || !Array.isArray(body.recipients) || typeof body.subject !== "string") {
      return c.json({ error: "sender, recipients, subject required" }, 400);
    }
    if (body.id !== undefined && !ID.test(body.id)) return c.json({ error: "id must be 22 base64url chars" }, 400);
    const id = body.id ?? newId();
    if (db.getMessage(id)) return c.json({ error: "id exists" }, 409);
    db.createMessage({
      id,
      sender: body.sender,
      recipients: body.recipients,
      subject: body.subject,
      source: body.source ?? "extension",
      tracking_mode: "legacy",
    });
    const pixelUrl = `${publicUrl}/p/${id}.gif`;
    return c.json({ id, pixelUrl }, 201);
  });

  const linkMessage = (recover: boolean) => async (c: Context<{}, "/messages/:id" | "/messages/:id/recover">) => {
    const body = await c.req.json<{ gmailMessageId: string; gmailThreadId: string; sender?: string }>();
    if (typeof body.gmailMessageId !== "string" || !body.gmailMessageId || typeof body.gmailThreadId !== "string" || !body.gmailThreadId) {
      return c.json({ error: "gmailMessageId, gmailThreadId required" }, 400);
    }
    const id = c.req.param("id");
    if (recover) {
      if (typeof body.sender !== "string" || !body.sender) return c.json({ error: "sender required for recovery" }, 400);
      const message = db.getMessage(id);
      if (!message) return c.json({ error: "not found" }, 404);
      if (message.sender.toLowerCase() !== body.sender.toLowerCase()) return c.json({ error: "sender does not match" }, 409);
    }
    const ok = db.markSent(
      id,
      {
        messageId: body.gmailMessageId,
        threadId: body.gmailThreadId,
      },
      recover,
    );
    if (ok) return c.body(null, 204);
    return db.getMessage(id) ? c.json({ error: "already linked to a different Gmail message" }, 409) : c.json({ error: "not found" }, 404);
  };
  api.patch("/messages/:id", linkMessage(false));
  // A separate route makes recovery fail safely against older servers instead of resetting send time.
  api.patch("/messages/:id/recover", linkMessage(true));

  api.post("/views", async (c) => {
    const body = await c.req.json<{ gmailMessageId: string }>();
    if (!body.gmailMessageId) return c.json({ error: "gmailMessageId required" }, 400);
    db.recordView(body.gmailMessageId);
    return c.body(null, 204);
  });

  api.get("/status", (c) => {
    const split = (v: string | undefined) => (v ? v.split(",").filter(Boolean).slice(0, 200) : []);
    const messageIds = split(c.req.query("messageIds"));
    const threadIds = split(c.req.query("threadIds"));
    const messages: Record<string, MessageSummary> = {};
    for (const m of db.findByGmailMessageIds(messageIds)) messages[m.gmail_message_id!] = summaryOf(m);

    const threads: Record<string, ThreadSummaryResponse> = {};
    const threadRecipients = new Map<string, Set<string>>();
    const threadOpenedRecipients = new Map<string, Set<string>>();

    for (const m of db.findByGmailThreadIds(threadIds)) {
      const s = summaryOf(m);
      const tid = m.gmail_thread_id!;
      const t = (threads[tid] ??= {
        tracked: 0,
        opens: 0,
        lastOpenAt: null,
        late: null,
        appleMpp: 0,
        lastAppleMppAt: null,
        recipientCount: 0,
        openedRecipients: 0,
        openedRecipientEmails: [],
      });
      t.tracked++;
      t.opens += s.opens;
      t.appleMpp += s.appleMpp;
      if (s.lastOpenAt && (!t.lastOpenAt || s.lastOpenAt > t.lastOpenAt)) {
        t.lastOpenAt = s.lastOpenAt;
        t.late = s.late;
      }
      if (s.lastAppleMppAt && (!t.lastAppleMppAt || s.lastAppleMppAt > t.lastAppleMppAt)) {
        t.lastAppleMppAt = s.lastAppleMppAt;
      }
      const allRecs = threadRecipients.get(tid) ?? new Set<string>();
      const openedRecs = threadOpenedRecipients.get(tid) ?? new Set<string>();
      if (s.recipientSummaries) {
        for (const rs of s.recipientSummaries) {
          allRecs.add(rs.recipient);
          if (rs.opens > 0) openedRecs.add(rs.recipient);
        }
      } else {
        for (const r of m.recipients) allRecs.add(r.toLowerCase());
        if (m.recipients.length === 1 && s.opens > 0) openedRecs.add(m.recipients[0].toLowerCase());
      }
      threadRecipients.set(tid, allRecs);
      threadOpenedRecipients.set(tid, openedRecs);
      t.recipientCount = allRecs.size;
      t.openedRecipients = openedRecs.size;
      t.openedRecipientEmails = [...openedRecs];
    }
    return c.json({ messages, threads, classifierVersion: CLASSIFIER_VERSION });
  });

  /**
   * Tracked messages with their open summary, most recently opened first, then unopened by send time.
   * Excludes unsent outbox messages still queued/scheduled/failed (those live in /api/outbox).
   */
  api.get("/messages", (c) => {
    const since = Number(c.req.query("since") ?? 0);
    const sender = c.req.query("sender")?.toLowerCase();
    const offset = Number(c.req.query("offset") ?? 0);
    const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
    const hidden = unsentOutboxMessageIds();
    const ctx = createBatchContext();
    const all = ctx.allMessages
      .filter((m) => !hidden.has(m.id))
      .filter((m) => !sender || m.sender.toLowerCase() === sender)
      .map((m) => ({ ...m, ...summaryOf(m, ctx), hits: (ctx.hitsByMessage.get(m.id) ?? []).length }))
      .filter((m) => (m.sent_at ?? m.created_at) >= since || (m.lastOpenAt ?? 0) >= since)
      .sort((a, b) => (b.lastOpenAt ?? 0) - (a.lastOpenAt ?? 0) || (b.sent_at ?? b.created_at) - (a.sent_at ?? a.created_at));
    return c.json({ total: all.length, messages: all.slice(offset, offset + limit) });
  });

  api.get("/messages/:id", (c) => {
    const message = db.getMessage(c.req.param("id"));
    if (!message) return c.json({ error: "not found" }, 404);
    const { raw, classified, tokens } = classifyMessageHits(message);
    const tokenMap = new Map(tokens.map((t) => [t.token, t.recipient]));
    return c.json({
      ...message,
      ...summaryOf(message),
      hits: raw.map((h, i) => ({
        ...h,
        recipient: h.recipient_token ? tokenMap.get(h.recipient_token) ?? null : null,
        kind: classified[i].kind,
        reason: classified[i].reason,
        client: classified[i].client ?? null,
      })),
      views: message.gmail_message_id ? db.listViews(message.gmail_message_id) : [],
    });
  });

  // --- Per-contact open history ---

  type ContactMessageEntry = {
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
    late: OpenSummary["late"];
    appleMpp: number;
    lastAppleMppAt: number | null;
    appleMppAts: number[];
  };

  type ContactAggregate = {
    email: string;
    messages: number;
    attributableMessages: number;
    openedMessages: number;
    appleMppMessages: number;
    totalOpens: number;
    lastOpenAt: number | null;
    lastSentAt: number | null;
    entries: ContactMessageEntry[];
  };

  function buildContacts(sender?: string): Map<string, ContactAggregate> {
    const hidden = unsentOutboxMessageIds();
    const ctx = createBatchContext();
    const contacts = new Map<string, ContactAggregate>();
    const ensure = (email: string): ContactAggregate => {
      const key = email.toLowerCase();
      let agg = contacts.get(key);
      if (!agg) {
        agg = {
          email: key,
          messages: 0,
          attributableMessages: 0,
          openedMessages: 0,
          appleMppMessages: 0,
          totalOpens: 0,
          lastOpenAt: null,
          lastSentAt: null,
          entries: [],
        };
        contacts.set(key, agg);
      }
      return agg;
    };

    for (const m of ctx.allMessages) {
      if (hidden.has(m.id)) continue;
      if (sender && m.sender.toLowerCase() !== sender) continue;
      const summary = summaryOf(m, ctx);
      const sentAt = m.sent_at ?? m.created_at;

      if (m.tracking_mode === "per_recipient" && summary.recipientSummaries) {
        for (const rs of summary.recipientSummaries) {
          const agg = ensure(rs.recipient);
          agg.messages++;
          agg.attributableMessages++;
          if (rs.opens > 0) {
            agg.openedMessages++;
            agg.totalOpens += rs.opens;
            if (rs.lastOpenAt && (!agg.lastOpenAt || rs.lastOpenAt > agg.lastOpenAt)) agg.lastOpenAt = rs.lastOpenAt;
          } else if (rs.appleMpp > 0) {
            agg.appleMppMessages++;
          }
          if (!agg.lastSentAt || sentAt > agg.lastSentAt) agg.lastSentAt = sentAt;
          agg.entries.push({
            id: m.id,
            subject: m.subject,
            recipients: m.recipients,
            gmail_thread_id: m.gmail_thread_id,
            sent_at: m.sent_at,
            created_at: m.created_at,
            attribution: "individual",
            opens: rs.opens,
            firstOpenAt: rs.firstOpenAt,
            lastOpenAt: rs.lastOpenAt,
            openAts: rs.openAts,
            late: rs.late,
            appleMpp: rs.appleMpp,
            lastAppleMppAt: rs.lastAppleMppAt,
            appleMppAts: rs.appleMppAts,
          });
        }
      } else {
        const isSingle = m.recipients.length === 1;
        const uniqueRecipients = [...new Set(m.recipients.map((r) => r.toLowerCase()))];
        for (const r of uniqueRecipients) {
          const agg = ensure(r);
          agg.messages++;
          if (!agg.lastSentAt || sentAt > agg.lastSentAt) agg.lastSentAt = sentAt;
          if (isSingle) {
            agg.attributableMessages++;
            if (summary.opens > 0) {
              agg.openedMessages++;
              agg.totalOpens += summary.opens;
              if (summary.lastOpenAt && (!agg.lastOpenAt || summary.lastOpenAt > agg.lastOpenAt)) {
                agg.lastOpenAt = summary.lastOpenAt;
              }
            } else if (summary.appleMpp > 0) {
              agg.appleMppMessages++;
            }
          }
          agg.entries.push({
            id: m.id,
            subject: m.subject,
            recipients: m.recipients,
            gmail_thread_id: m.gmail_thread_id,
            sent_at: m.sent_at,
            created_at: m.created_at,
            attribution: isSingle ? "individual" : "group_unknown",
            opens: summary.opens,
            firstOpenAt: summary.firstOpenAt,
            lastOpenAt: summary.lastOpenAt,
            openAts: summary.openAts,
            late: summary.late,
            appleMpp: summary.appleMpp,
            lastAppleMppAt: summary.lastAppleMppAt,
            appleMppAts: summary.appleMppAts,
          });
        }
      }
    }

    for (const agg of contacts.values()) {
      agg.entries.sort((a, b) => (b.sent_at ?? b.created_at) - (a.sent_at ?? a.created_at));
    }
    return contacts;
  }

  api.post("/messages/:id/dismiss-followup", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ dismissed?: boolean }>().catch(() => ({ dismissed: true }));
    const dismissed = body.dismissed !== false;
    const ok = db.setFollowupDismissed(id, dismissed ? Date.now() : null);
    if (!ok) return c.json({ error: "not found" }, 404);
    return c.body(null, 204);
  });

  api.post("/followups/refresh", async (c) => {
    const body = await c.req.json<{ sender?: string; force?: boolean }>().catch(() => ({} as { sender?: string; force?: boolean }));
    const result = await replyChecker.check({ sender: body.sender, force: body.force !== false });
    return c.json(result);
  });

  api.get("/contacts", (c) => {
    const sender = c.req.query("sender")?.toLowerCase();
    const q = c.req.query("q")?.trim().toLowerCase() ?? "";
    const all = [...buildContacts(sender).values()]
      .filter((contact) => !q || contact.email.includes(q))
      .sort((a, b) => (b.lastOpenAt ?? 0) - (a.lastOpenAt ?? 0) || (b.lastSentAt ?? 0) - (a.lastSentAt ?? 0))
      .map(({ entries: _, ...rest }) => rest);
    return c.json({ total: all.length, contacts: all });
  });

  api.get("/contacts/:email", (c) => {
    const sender = c.req.query("sender")?.toLowerCase();
    const email = decodeURIComponent(c.req.param("email")).toLowerCase();
    const contact = buildContacts(sender).get(email);
    if (!contact) return c.json({ error: "not found" }, 404);
    const { entries, ...summary } = contact;
    return c.json({ contact: summary, messages: entries });
  });

  // --- Server settings & Discord notifications ---

  api.get("/settings", (c) => {
    return c.json(settings.getPublic());
  });

  api.patch("/settings", async (c) => {
    const body = await c.req.json<ServerSettingsPatch>().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid settings payload" }, 400);
    }
    if (body.ignoredIps !== undefined && !isStringArray(body.ignoredIps)) {
      return c.json({ error: "ignoredIps must be an array of strings" }, 400);
    }
    try {
      const updated = settings.update(body);
      return c.json(updated);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  api.post("/notifications/test", async (c) => {
    const body = await c.req
      .json<{ discordWebhookUrl?: string }>()
      .catch(() => ({} as { discordWebhookUrl?: string }));
    const override = body.discordWebhookUrl?.trim();
    if (override && !isValidDiscordWebhookUrl(override)) {
      return c.json({ error: "Discord webhook URL must be a valid https://discord.com/api/webhooks/... URL" }, 400);
    }
    try {
      await notifier.sendTest(override || undefined);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  api.post("/notifications/digest", async (c) => {
    try {
      const result = await notifier.sendDigest({ force: true });
      if (!result.sent) {
        return c.json({ error: result.skipped === "no_webhook" ? "No Discord webhook URL configured" : `Digest skipped: ${result.skipped}` }, 400);
      }
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  app.route("/api", api);

  return Object.assign(app, { outbox, replyChecker, notifier, settings, appleRelay, cipher });
}
