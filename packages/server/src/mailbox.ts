import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { extractEmailAddress, parseDraftMime } from "./mime.js";

export type OAuthCredentials = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

export type AppPasswordCredentials = {
  appPassword: string;
};

export type ThreadReplyHeaders = {
  inReplyTo?: string;
  references?: string;
  subject?: string;
};

export type ThreadActivity = {
  repliedAt: number | null;
  repliedBy: { email: string; at: number }[];
  bouncedAt: number | null;
  bounceReason: string | null;
};

export type ReplaceSentArgs = {
  sentMessageIds: string[];
  recipientTokens: string[];
  subject: string;
  cleanRaw: Buffer;
  threadId?: string | null;
  sentAt: number;
};

export type ReplaceSentResult = {
  gmailMessageId: string;
  gmailThreadId: string;
  cleanedCopies?: number;
  expectedCopies?: number;
};

export type CleanupSentArgs = {
  sentMessageIds: string[];
  recipientTokens: string[];
  keepMessageId: string;
  sentAt: number;
};

export interface MailboxTransport {
  readonly email: string;
  verify(): Promise<void>;
  getThreadReplyHeaders(threadId: string): Promise<ThreadReplyHeaders | null>;
  /** Returns the earliest reply timestamp from someone other than `senderEmail` in `threadId` after `sentAt`, or null. */
  getThreadReplyAt?(threadId: string, sentAt: number, senderEmail: string): Promise<number | null>;
  /** Inspects a thread for human replies (with senders) and delivery bounces after `sentAt`. */
  inspectThreadActivity?(threadId: string, sentAt: number, senderEmail: string): Promise<ThreadActivity>;
  getDraftRaw(draftId?: string | null, draftMessageId?: string | null): Promise<{ raw: Buffer; threadId?: string } | null>;
  deleteDraft(draftId?: string | null, draftMessageId?: string | null): Promise<void>;
  createDraft(raw: Buffer, threadId?: string | null): Promise<{ draftId: string; messageId: string }>;
  sendSmtpCopy(envelopeFrom: string, envelopeTo: string, raw: Buffer): Promise<void>;
  replaceSentCopies(args: ReplaceSentArgs): Promise<ReplaceSentResult>;
  /** Sweeps Sent for any stray pixel-bearing SMTP copies that Gmail indexed after initial send. */
  cleanupSentCopies?(args: CleanupSentArgs): Promise<number>;
}

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_TIMEOUT_MS = 20_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function refreshGoogleAccessToken(creds: OAuthCredentials): Promise<{ accessToken: string; expiresAt: number }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const body = (await res.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(`Google OAuth token refresh failed: ${body.error ?? res.status} ${body.error_description ?? ""}`.trim());
  }
  return {
    accessToken: body.access_token,
    expiresAt: Date.now() + Math.max(60, (body.expires_in ?? 3600) - 60) * 1000,
  };
}

export async function fetchGoogleProfileEmail(accessToken: string): Promise<string> {
  const res = await fetch(`${GMAIL_API}/profile`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Gmail profile check failed: HTTP ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { emailAddress?: string };
  if (!data.emailAddress) throw new Error("Gmail profile missing emailAddress");
  return data.emailAddress.toLowerCase();
}

const BOUNCE_LOCAL_PARTS = /^(mailer-daemon|postmaster)$/i;
const BOUNCE_SUBJECT = /\b(delivery status notification|undeliverable|returned mail|mail delivery subsystem|failure notice|address not found)\b/i;
const DELAY_SUBJECT = /\b(delay|delayed|delivery incomplete|temporary failure|still trying|warning)\b/i;

export type MessageHeaderSummary = {
  from?: string;
  subject?: string;
  autoSubmitted?: string;
  returnPath?: string;
  failedRecipients?: string;
  contentType?: string;
};

export type DsnClassification =
  | { kind: "bounce"; reason: string }
  | { kind: "delay"; reason: string }
  | { kind: "human"; reason: null };

/**
 * Classifies whether a thread message is a permanent delivery bounce, a temporary delivery delay
 * warning (such as Gmail's "Delivery Status Notification (Delay)"), or a regular human message.
 */
export function classifyDsnMessage(h: MessageHeaderSummary): DsnClassification {
  const fromEmail = h.from ? extractEmailAddress(h.from) : "";
  const localPart = fromEmail.split("@")[0] ?? "";
  const failed = h.failedRecipients?.trim();
  const subject = h.subject?.trim() || null;
  const isDelaySubject = Boolean(subject && DELAY_SUBJECT.test(subject));
  const isDsnReport = Boolean(h.contentType && /report-type\s*=\s*"?delivery-status"?/i.test(h.contentType));
  const isDaemonSender = Boolean(localPart && BOUNCE_LOCAL_PARTS.test(localPart));
  const emptyReturnPath = h.returnPath?.trim() === "<>";
  const auto = (h.autoSubmitted ?? "").trim().toLowerCase();
  const isAutoDsn = emptyReturnPath && Boolean(auto) && auto !== "no" && Boolean(subject && BOUNCE_SUBJECT.test(subject));

  if (isDelaySubject && (isDaemonSender || isDsnReport || isAutoDsn)) {
    return { kind: "delay", reason: subject! };
  }
  if (failed) {
    return { kind: "bounce", reason: `Delivery failed for ${failed}` };
  }
  if (isDsnReport) {
    return { kind: "bounce", reason: subject ?? "Delivery status notification" };
  }
  if (isDaemonSender) {
    return { kind: "bounce", reason: subject ?? `Bounce from ${fromEmail}` };
  }
  if (isAutoDsn) {
    return { kind: "bounce", reason: subject! };
  }
  return { kind: "human", reason: null };
}

/** Identifies permanent Delivery Status Notification (bounce) messages. */
export function isBounceMessage(h: MessageHeaderSummary): { bounce: boolean; reason: string | null } {
  const res = classifyDsnMessage(h);
  return res.kind === "bounce" ? { bounce: true, reason: res.reason } : { bounce: false, reason: null };
}

async function rawMatchesOwnTokens(raw: Buffer, tokens: string[]): Promise<boolean> {
  if (tokens.length === 0) return false;
  try {
    const parsed = await parseDraftMime(raw);
    const html = parsed.html ?? "";
    // Tokens are 128-bit random IDs unique to this send, so checking them directly works even with Send-As aliases.
    return tokens.some((tok) => html.includes(`/p/${tok}.gif`));
  } catch {
    return false;
  }
}

export function createOAuthTransport(email: string, creds: OAuthCredentials): MailboxTransport {
  let cached: { accessToken: string; expiresAt: number } | null = null;
  const senderLower = email.toLowerCase();

  async function getAccessToken(): Promise<string> {
    if (!cached || Date.now() >= cached.expiresAt) {
      cached = await refreshGoogleAccessToken(creds);
    }
    return cached.accessToken;
  }

  async function gmailFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await getAccessToken();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    return fetch(`${GMAIL_API}${path}`, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(API_TIMEOUT_MS),
    });
  }

  async function gmailJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await gmailFetch(path, init);
    if (!res.ok) throw new Error(`Gmail API ${init.method ?? "GET"} ${path}: HTTP ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  async function resolveDraftId(draftId?: string | null, draftMessageId?: string | null): Promise<string | null> {
    const candidates = [draftId, draftMessageId].filter((x): x is string => Boolean(x));
    if (candidates.length === 0) return null;
    if (draftId) {
      const direct = await gmailFetch(`/drafts/${encodeURIComponent(draftId)}?format=minimal`);
      if (direct.ok) return draftId;
    }
    const list = await gmailJson<{ drafts?: { id: string; message?: { id: string } }[] }>("/drafts?maxResults=100");
    for (const d of list.drafts ?? []) {
      if (candidates.includes(d.id) || (d.message?.id && candidates.includes(d.message.id))) {
        return d.id;
      }
    }
    return null;
  }

  function smtpTransporter(accessToken: string) {
    return nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      connectionTimeout: API_TIMEOUT_MS,
      greetingTimeout: API_TIMEOUT_MS,
      socketTimeout: API_TIMEOUT_MS,
      auth: {
        type: "OAuth2",
        user: email,
        accessToken,
      },
    });
  }

  async function inspectThreadActivity(threadId: string, sentAt: number, senderEmail: string): Promise<ThreadActivity> {
    const headersQuery = [
      "From",
      "Subject",
      "Auto-Submitted",
      "Return-Path",
      "X-Failed-Recipients",
      "Content-Type",
    ]
      .map((h) => `metadataHeaders=${encodeURIComponent(h)}`)
      .join("&");
    const res = await gmailFetch(`/threads/${encodeURIComponent(threadId)}?format=metadata&${headersQuery}`);
    if (res.status === 404) return { repliedAt: null, repliedBy: [], bouncedAt: null, bounceReason: null };
    if (!res.ok) throw new Error(`Gmail thread reply check failed: HTTP ${res.status}`);
    const data = (await res.json()) as {
      messages?: {
        internalDate?: string;
        labelIds?: string[];
        payload?: { headers?: { name: string; value: string }[] };
      }[];
    };
    const me = senderEmail.toLowerCase();
    let repliedAt: number | null = null;
    const repliedByMap = new Map<string, number>();
    let bouncedAt: number | null = null;
    let bounceReason: string | null = null;

    for (const m of data.messages ?? []) {
      if (m.labelIds?.includes("DRAFT") || m.labelIds?.includes("TRASH")) continue;
      const ts = Number(m.internalDate ?? 0);
      if (!ts || ts <= sentAt) continue;
      const headers = m.payload?.headers ?? [];
      const h = (name: string) => headers.find((x) => x.name.toLowerCase() === name)?.value;
      const fromHeader = h("from") ?? "";
      const dsn = classifyDsnMessage({
        from: fromHeader,
        subject: h("subject"),
        autoSubmitted: h("auto-submitted"),
        returnPath: h("return-path"),
        failedRecipients: h("x-failed-recipients"),
        contentType: h("content-type"),
      });
      if (dsn.kind === "delay") continue;
      if (dsn.kind === "bounce") {
        if (bouncedAt === null || ts < bouncedAt) {
          bouncedAt = ts;
          bounceReason = dsn.reason;
        }
        continue;
      }
      const fromEmail = extractEmailAddress(fromHeader);
      if (!fromEmail || fromEmail === me) continue;
      if (repliedAt === null || ts < repliedAt) repliedAt = ts;
      const prev = repliedByMap.get(fromEmail);
      if (prev === undefined || ts < prev) repliedByMap.set(fromEmail, ts);
    }
    const repliedBy = [...repliedByMap.entries()]
      .map(([email, at]) => ({ email, at }))
      .sort((a, b) => a.at - b.at);
    return { repliedAt, repliedBy, bouncedAt, bounceReason };
  }

  async function cleanupSentCopiesTracked(args: CleanupSentArgs, alreadyTrashed: Set<string>): Promise<number> {
    const newlyFound = new Set<string>();
    const expected = args.sentMessageIds.length;

    // Pass A: exact Message-ID lookup (works when Gmail preserves our SMTP Message-ID).
    for (const msgid of args.sentMessageIds) {
      const cleanId = msgid.replace(/^<|>$/g, "");
      const q = encodeURIComponent(`in:sent rfc822msgid:${cleanId}`);
      const res = await gmailJson<{ messages?: { id: string }[] }>(`/messages?q=${q}&maxResults=5`);
      for (const m of res.messages ?? []) {
        if (m.id !== args.keepMessageId && !alreadyTrashed.has(m.id)) newlyFound.add(m.id);
      }
    }

    // Pass B: direct SENT label list (no full-text search index lag, handles consumer Gmail Message-ID rewrites & Send-As aliases).
    if (alreadyTrashed.size + newlyFound.size < expected && args.recipientTokens.length > 0) {
      const recent = await gmailJson<{ messages?: { id: string }[] }>("/messages?labelIds=SENT&maxResults=25");
      for (const m of recent.messages ?? []) {
        if (m.id === args.keepMessageId || alreadyTrashed.has(m.id) || newlyFound.has(m.id)) continue;
        const rawRes = await gmailFetch(`/messages/${encodeURIComponent(m.id)}?format=raw`);
        if (!rawRes.ok) continue;
        const rawData = (await rawRes.json()) as { raw?: string; internalDate?: string };
        if (!rawData.raw) continue;
        const internalDate = Number(rawData.internalDate ?? 0);
        if (internalDate && Math.abs(internalDate - args.sentAt) > 180_000) continue;
        const rawBuf = Buffer.from(rawData.raw, "base64url");
        if (await rawMatchesOwnTokens(rawBuf, args.recipientTokens)) {
          newlyFound.add(m.id);
        }
      }
    }

    let trashedNow = 0;
    for (const dupId of newlyFound) {
      // Reversible move to Trash instead of permanent delete.
      const res = await gmailFetch(`/messages/${encodeURIComponent(dupId)}/trash`, { method: "POST" });
      if (res.ok || res.status === 404) {
        alreadyTrashed.add(dupId);
        if (res.ok) trashedNow++;
      } else {
        console.error(`[open-mailtrack] failed trashing duplicate sent copy ${dupId}: HTTP ${res.status}`);
      }
    }

    return trashedNow;
  }

  return {
    email,

    async verify() {
      const token = await getAccessToken();
      const profileEmail = await fetchGoogleProfileEmail(token);
      if (profileEmail !== senderLower) {
        throw new Error(`OAuth token belongs to ${profileEmail}, not ${email}`);
      }
      const transport = smtpTransporter(token);
      try {
        await transport.verify();
      } finally {
        transport.close();
      }
    },

    async getThreadReplyHeaders(threadId: string): Promise<ThreadReplyHeaders | null> {
      const res = await gmailFetch(
        `/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject`,
      );
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Gmail thread fetch failed: HTTP ${res.status}`);
      const data = (await res.json()) as {
        messages?: { payload?: { headers?: { name: string; value: string }[] } }[];
      };
      const last = data.messages?.at(-1);
      const headers = last?.payload?.headers ?? [];
      const h = (name: string) => headers.find((x) => x.name.toLowerCase() === name)?.value;
      const msgId = h("message-id");
      const existingRefs = h("references");
      const references = [existingRefs, msgId].filter(Boolean).join(" ").trim() || undefined;
      return { inReplyTo: msgId, references, subject: h("subject") };
    },

    inspectThreadActivity,

    async getThreadReplyAt(threadId: string, sentAt: number, senderEmail: string): Promise<number | null> {
      const activity = await inspectThreadActivity(threadId, sentAt, senderEmail);
      return activity.repliedAt;
    },

    async getDraftRaw(draftId?: string | null, draftMessageId?: string | null): Promise<{ raw: Buffer; threadId?: string } | null> {
      const resolved = await resolveDraftId(draftId, draftMessageId);
      if (resolved) {
        const res = await gmailFetch(`/drafts/${encodeURIComponent(resolved)}?format=raw`);
        if (res.ok) {
          const data = (await res.json()) as { message?: { raw?: string; threadId?: string } };
          if (data.message?.raw) {
            return { raw: Buffer.from(data.message.raw, "base64url"), threadId: data.message.threadId };
          }
        }
      }
      // Fallback: check draftMessageId directly, strictly verifying it carries the DRAFT label.
      const msgId = draftMessageId || draftId;
      if (!msgId) return null;
      const msgRes = await gmailFetch(`/messages/${encodeURIComponent(msgId)}?format=raw`);
      if (!msgRes.ok) return null;
      const msg = (await msgRes.json()) as { raw?: string; threadId?: string; labelIds?: string[] };
      if (!msg.labelIds?.includes("DRAFT") || !msg.raw) return null;
      return { raw: Buffer.from(msg.raw, "base64url"), threadId: msg.threadId };
    },

    async deleteDraft(draftId?: string | null, draftMessageId?: string | null): Promise<void> {
      const resolved = await resolveDraftId(draftId, draftMessageId);
      if (!resolved) return;
      const res = await gmailFetch(`/drafts/${encodeURIComponent(resolved)}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        throw new Error(`Gmail draft delete failed: HTTP ${res.status}`);
      }
    },

    async createDraft(raw: Buffer, threadId?: string | null): Promise<{ draftId: string; messageId: string }> {
      const rawB64 = raw.toString("base64url");
      const post = (tid?: string | null) =>
        gmailFetch("/drafts", {
          method: "POST",
          body: JSON.stringify({ message: tid ? { raw: rawB64, threadId: tid } : { raw: rawB64 } }),
        });
      let res = await post(threadId);
      if (res.status === 404 && threadId) res = await post(null);
      if (!res.ok) throw new Error(`Gmail API POST /drafts: HTTP ${res.status} ${await res.text()}`);
      const data = (await res.json()) as { id: string; message: { id: string } };
      return { draftId: data.id, messageId: data.message.id };
    },

    async sendSmtpCopy(envelopeFrom: string, envelopeTo: string, raw: Buffer): Promise<void> {
      const token = await getAccessToken();
      const transport = smtpTransporter(token);
      try {
        await transport.sendMail({
          raw,
          envelope: { from: envelopeFrom, to: envelopeTo },
        });
      } finally {
        transport.close();
      }
    },

    async cleanupSentCopies(args: CleanupSentArgs): Promise<number> {
      return cleanupSentCopiesTracked(args, new Set<string>());
    },

    async replaceSentCopies(args: ReplaceSentArgs): Promise<ReplaceSentResult> {
      // 1. Insert the clean, pixel-free copy into SENT first so the thread never looks missing.
      // If threadId came from a deleted brand-new draft, Gmail returns 404; retry cleanly without threadId.
      const rawB64 = args.cleanRaw.toString("base64url");
      const insertMsg = (tid?: string | null) =>
        gmailFetch("/messages?internalDateSource=dateHeader", {
          method: "POST",
          body: JSON.stringify(tid ? { raw: rawB64, labelIds: ["SENT"], threadId: tid } : { raw: rawB64, labelIds: ["SENT"] }),
        });
      let insertRes = await insertMsg(args.threadId);
      if (insertRes.status === 404 && args.threadId) {
        insertRes = await insertMsg(null);
      }
      if (!insertRes.ok) {
        throw new Error(`Gmail API POST /messages?internalDateSource=dateHeader: HTTP ${insertRes.status} ${await insertRes.text()}`);
      }
      const inserted = (await insertRes.json()) as { id: string; threadId: string };

      // 2. Locate the N auto-saved SMTP copies in SENT and move them reversibly to Trash,
      // deduplicating trashed IDs across retry iterations so search-index lag cannot over-count.
      const expected = args.sentMessageIds.length;
      const delays = [500, 1000, 1500, 2000];
      const trashedIds = new Set<string>();

      for (const delay of delays) {
        await sleep(delay);
        await cleanupSentCopiesTracked(
          {
            sentMessageIds: args.sentMessageIds,
            recipientTokens: args.recipientTokens,
            keepMessageId: inserted.id,
            sentAt: args.sentAt,
          },
          trashedIds,
        );
        if (trashedIds.size >= expected) break;
      }

      return {
        gmailMessageId: inserted.id,
        gmailThreadId: inserted.threadId,
        cleanedCopies: trashedIds.size,
        expectedCopies: expected,
      };
    },
  };
}

function hexToDec(hex: string): string | null {
  try {
    if (!/^[0-9a-f]+$/i.test(hex)) return null;
    return BigInt(`0x${hex}`).toString(10);
  } catch {
    return null;
  }
}

function decToHex(dec: string | bigint | undefined): string {
  if (dec === undefined) return "";
  return BigInt(dec).toString(16).padStart(16, "0");
}

export function createAppPasswordTransport(email: string, creds: AppPasswordCredentials): MailboxTransport {
  function smtpTransporter() {
    return nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      connectionTimeout: API_TIMEOUT_MS,
      greetingTimeout: API_TIMEOUT_MS,
      socketTimeout: API_TIMEOUT_MS,
      auth: {
        user: email,
        pass: creds.appPassword,
      },
    });
  }

  async function withImap<T>(
    fn: (client: ImapFlow, boxes: { sent: string; drafts: string; trash: string }) => Promise<T>,
  ): Promise<T> {
    const client = new ImapFlow({
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      auth: { user: email, pass: creds.appPassword },
      logger: false,
    });
    await client.connect();
    try {
      const list = await client.list();
      const findBox = (specialUse: string, fallback: string) =>
        list.find((b) => b.specialUse === specialUse)?.path ?? fallback;
      const boxes = {
        sent: findBox("\\Sent", "[Gmail]/Sent Mail"),
        drafts: findBox("\\Drafts", "[Gmail]/Drafts"),
        trash: findBox("\\Trash", "[Gmail]/Trash"),
      };
      return await fn(client, boxes);
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async function inspectThreadActivity(threadId: string, sentAt: number, senderEmail: string): Promise<ThreadActivity> {
    const dec = hexToDec(threadId);
    if (!dec) return { repliedAt: null, repliedBy: [], bouncedAt: null, bounceReason: null };
    const me = senderEmail.toLowerCase();
    return withImap(async (client) => {
      const list = await client.list();
      const allMail = list.find((b) => b.specialUse === "\\All")?.path ?? "[Gmail]/All Mail";
      const lock = await client.getMailboxLock(allMail);
      try {
        const uids = await client.search({ threadId: dec }, { uid: true });
        if (!uids || uids.length === 0) {
          return { repliedAt: null, repliedBy: [], bouncedAt: null, bounceReason: null };
        }
        let repliedAt: number | null = null;
        const repliedByMap = new Map<string, number>();
        let bouncedAt: number | null = null;
        let bounceReason: string | null = null;

        for (const uid of uids) {
          const msg = await client.fetchOne(
            String(uid),
            {
              envelope: true,
              internalDate: true,
              flags: true,
              headers: ["from", "subject", "auto-submitted", "return-path", "x-failed-recipients", "content-type"],
            },
            { uid: true },
          );
          if (!msg || msg.flags?.has("\\Draft")) continue;
          const ts = msg.internalDate ? new Date(msg.internalDate).getTime() : 0;
          if (!ts || ts <= sentAt) continue;
          const headerText = msg.headers ? msg.headers.toString("utf8") : "";
          const getHeader = (name: string) => {
            const re = new RegExp(`^${name}:\\s*(.+(?:\\r?\\n[ \\t].+)*)`, "im");
            const m = re.exec(headerText);
            return m ? m[1].replace(/\r?\n[ \t]+/g, " ").trim() : undefined;
          };
          const fromAddr = msg.envelope?.from?.[0]?.address?.toLowerCase() ?? extractEmailAddress(getHeader("from") ?? "");
          const dsn = classifyDsnMessage({
            from: fromAddr || getHeader("from"),
            subject: msg.envelope?.subject ?? getHeader("subject"),
            autoSubmitted: getHeader("auto-submitted"),
            returnPath: getHeader("return-path"),
            failedRecipients: getHeader("x-failed-recipients"),
            contentType: getHeader("content-type"),
          });
          if (dsn.kind === "delay") continue;
          if (dsn.kind === "bounce") {
            if (bouncedAt === null || ts < bouncedAt) {
              bouncedAt = ts;
              bounceReason = dsn.reason;
            }
            continue;
          }
          if (!fromAddr || fromAddr === me) continue;
          if (repliedAt === null || ts < repliedAt) repliedAt = ts;
          const prev = repliedByMap.get(fromAddr);
          if (prev === undefined || ts < prev) repliedByMap.set(fromAddr, ts);
        }
        const repliedBy = [...repliedByMap.entries()]
          .map(([email, at]) => ({ email, at }))
          .sort((a, b) => a.at - b.at);
        return { repliedAt, repliedBy, bouncedAt, bounceReason };
      } finally {
        lock.release();
      }
    });
  }

  return {
    email,

    async verify() {
      const transport = smtpTransporter();
      try {
        await transport.verify();
      } finally {
        transport.close();
      }
      await withImap(async () => {});
    },

    async getThreadReplyHeaders(threadId: string): Promise<ThreadReplyHeaders | null> {
      const dec = hexToDec(threadId);
      if (!dec) return null;
      return withImap(async (client) => {
        const list = await client.list();
        const allMail = list.find((b) => b.specialUse === "\\All")?.path ?? "[Gmail]/All Mail";
        const lock = await client.getMailboxLock(allMail);
        try {
          const uids = await client.search({ threadId: dec }, { uid: true });
          if (!uids || uids.length === 0) return null;
          const lastUid = uids[uids.length - 1];
          const msg = await client.fetchOne(
            String(lastUid),
            { envelope: true, headers: ["message-id", "references", "subject"] },
            { uid: true },
          );
          if (!msg) return null;
          const headerText = msg.headers ? msg.headers.toString("utf8") : "";
          const getHeader = (name: string) => {
            const re = new RegExp(`^${name}:\\s*(.+(?:\\r?\\n[ \\t].+)*)`, "im");
            const m = re.exec(headerText);
            return m ? m[1].replace(/\r?\n[ \t]+/g, " ").trim() : undefined;
          };
          const msgId = msg.envelope?.messageId ?? getHeader("message-id");
          const existingRefs = getHeader("references");
          const references = [existingRefs, msgId].filter(Boolean).join(" ").trim() || undefined;
          return { inReplyTo: msgId, references, subject: msg.envelope?.subject ?? getHeader("subject") };
        } finally {
          lock.release();
        }
      });
    },

    inspectThreadActivity,

    async getThreadReplyAt(threadId: string, sentAt: number, senderEmail: string): Promise<number | null> {
      const activity = await inspectThreadActivity(threadId, sentAt, senderEmail);
      return activity.repliedAt;
    },

    async getDraftRaw(draftId?: string | null, draftMessageId?: string | null): Promise<{ raw: Buffer; threadId?: string } | null> {
      const dec = hexToDec(draftMessageId ?? "") ?? hexToDec(draftId ?? "");
      if (!dec) return null;
      return withImap(async (client, boxes) => {
        const lock = await client.getMailboxLock(boxes.drafts);
        try {
          const uids = await client.search({ emailId: dec }, { uid: true });
          if (!uids || uids.length === 0) return null;
          const msg = await client.fetchOne(String(uids[0]), { source: true, threadId: true }, { uid: true });
          if (!msg || !msg.source) return null;
          return { raw: Buffer.from(msg.source), threadId: msg.threadId ? decToHex(msg.threadId) : undefined };
        } finally {
          lock.release();
        }
      });
    },

    async deleteDraft(draftId?: string | null, draftMessageId?: string | null): Promise<void> {
      const dec = hexToDec(draftMessageId ?? "") ?? hexToDec(draftId ?? "");
      if (!dec) return;
      await withImap(async (client, boxes) => {
        const lock = await client.getMailboxLock(boxes.drafts);
        try {
          const found = await client.search({ emailId: dec }, { uid: true });
          if (found && found.length > 0) {
            // Reversible move to Trash instead of permanent expunge.
            await client.messageMove(found, boxes.trash, { uid: true });
          }
        } finally {
          lock.release();
        }
      });
    },

    async createDraft(raw: Buffer): Promise<{ draftId: string; messageId: string }> {
      return withImap(async (client, boxes) => {
        const appended = await client.append(boxes.drafts, raw, ["\\Draft"]);
        if (!appended || !appended.uid) return { draftId: "", messageId: "" };
        const lock = await client.getMailboxLock(boxes.drafts);
        try {
          const msg = await client.fetchOne(String(appended.uid), { emailId: true }, { uid: true });
          const hexId = msg && msg.emailId ? decToHex(msg.emailId) : "";
          return { draftId: hexId, messageId: hexId };
        } finally {
          lock.release();
        }
      });
    },

    async sendSmtpCopy(envelopeFrom: string, envelopeTo: string, raw: Buffer): Promise<void> {
      const transport = smtpTransporter();
      try {
        await transport.sendMail({
          raw,
          envelope: { from: envelopeFrom, to: envelopeTo },
        });
      } finally {
        transport.close();
      }
    },

    async cleanupSentCopies(args: CleanupSentArgs): Promise<number> {
      const keepDec = hexToDec(args.keepMessageId);
      return withImap(async (client, boxes) => {
        const lock = await client.getMailboxLock(boxes.sent);
        const dupUids = new Set<number>();
        try {
          for (const msgid of args.sentMessageIds) {
            const found = await client.search({ header: { "message-id": msgid } }, { uid: true });
            for (const uid of found || []) {
              dupUids.add(uid);
            }
          }
          if (dupUids.size < args.sentMessageIds.length && args.recipientTokens.length > 0) {
            const recent = await client.search({ since: new Date(Date.now() - 86_400_000) }, { uid: true });
            const tail = (recent || []).slice(-25);
            for (const uid of tail) {
              if (dupUids.has(uid)) continue;
              const msg = await client.fetchOne(String(uid), { source: true, internalDate: true, emailId: true }, { uid: true });
              if (!msg || !msg.source) continue;
              if (keepDec && msg.emailId && String(msg.emailId) === keepDec) continue;
              const dt = msg.internalDate ? new Date(msg.internalDate).getTime() : 0;
              if (dt && Math.abs(dt - args.sentAt) > 180_000) continue;
              if (await rawMatchesOwnTokens(Buffer.from(msg.source), args.recipientTokens)) {
                dupUids.add(uid);
              }
            }
          }
          if (keepDec && dupUids.size > 0) {
            for (const uid of [...dupUids]) {
              const meta = await client.fetchOne(String(uid), { emailId: true }, { uid: true });
              if (meta && meta.emailId && String(meta.emailId) === keepDec) dupUids.delete(uid);
            }
          }
          if (dupUids.size > 0) {
            await client.messageMove([...dupUids], boxes.trash, { uid: true });
          }
          return dupUids.size;
        } finally {
          lock.release();
        }
      });
    },

    async replaceSentCopies(args: ReplaceSentArgs): Promise<ReplaceSentResult> {
      return withImap(async (client, boxes) => {
        // 1. Append clean pixel-free copy to Sent first.
        const appended = await client.append(boxes.sent, args.cleanRaw, ["\\Seen"], new Date(args.sentAt));
        const cleanUid = appended && typeof appended === "object" ? appended.uid : undefined;
        let gmailMessageId = "";
        let gmailThreadId = args.threadId ?? "";

        const lock = await client.getMailboxLock(boxes.sent);
        const dupUids = new Set<number>();
        try {
          if (cleanUid) {
            const meta = await client.fetchOne(String(cleanUid), { emailId: true, threadId: true }, { uid: true });
            if (meta && meta.emailId) gmailMessageId = decToHex(meta.emailId);
            if (meta && meta.threadId) gmailThreadId = decToHex(meta.threadId);
          }

          const delays = [500, 1000, 1500, 2000];
          for (const delay of delays) {
            await sleep(delay);
            for (const msgid of args.sentMessageIds) {
              const found = await client.search({ header: { "message-id": msgid } }, { uid: true });
              for (const uid of found || []) {
                if (uid !== cleanUid) dupUids.add(uid);
              }
            }
            if (dupUids.size < args.sentMessageIds.length && args.recipientTokens.length > 0) {
              const recent = await client.search({ since: new Date(Date.now() - 86_400_000) }, { uid: true });
              const tail = (recent || []).slice(-25);
              for (const uid of tail) {
                if (uid === cleanUid || dupUids.has(uid)) continue;
                const msg = await client.fetchOne(String(uid), { source: true, internalDate: true }, { uid: true });
                if (!msg || !msg.source) continue;
                const dt = msg.internalDate ? new Date(msg.internalDate).getTime() : 0;
                if (dt && Math.abs(dt - args.sentAt) > 180_000) continue;
                if (await rawMatchesOwnTokens(Buffer.from(msg.source), args.recipientTokens)) {
                  dupUids.add(uid);
                }
              }
            }
            if (dupUids.size >= args.sentMessageIds.length) break;
          }

          // Reversible move to Trash; never re-scan or permanently expunge Trash.
          if (dupUids.size > 0) {
            await client.messageMove([...dupUids], boxes.trash, { uid: true });
          }
        } finally {
          lock.release();
        }

        return {
          gmailMessageId,
          gmailThreadId,
          cleanedCopies: dupUids.size,
          expectedCopies: args.sentMessageIds.length,
        };
      });
    },
  };
}
