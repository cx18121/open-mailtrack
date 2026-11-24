import { randomBytes } from "node:crypto";
import type { Cipher } from "./crypto.js";
import type { Account, Db, OutboxItem, RecipientKind } from "./db.js";
import {
  createAppPasswordTransport,
  createOAuthTransport,
  type AppPasswordCredentials,
  type MailboxTransport,
  type OAuthCredentials,
} from "./mailbox.js";
import {
  compileMime,
  extractEmailAddress,
  injectPixelIntoHtml,
  parseDraftMime,
  stripServerPixelsFromHtml,
  type MimeAttachment,
} from "./mime.js";

export const MAX_GROUP_RECIPIENTS = 25;
export const newTokenId = () => randomBytes(16).toString("base64url");

export class OutboxError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type OutboxPayload = {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  text?: string;
  inReplyTo?: string;
  references?: string;
  attachments: MimeAttachment[];
  source: "extension" | "cli";
  includeSelfDelivery: boolean;
};

export type EnqueueRequest = {
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
  clientRequestId?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: MimeAttachment[];
  sendAt?: number;
  undoDelayMs?: number;
  isScheduled?: boolean;
  source?: "extension" | "cli";
  sync?: boolean;
};

export type TransportFactory = (account: Account, cipher: Cipher) => MailboxTransport;

export const defaultTransportFactory: TransportFactory = (account, cipher) => {
  const raw = JSON.parse(cipher.decrypt(account.encrypted_credentials));
  if (account.auth_type === "oauth") {
    return createOAuthTransport(account.email, raw as OAuthCredentials);
  }
  return createAppPasswordTransport(account.email, raw as AppPasswordCredentials);
};

export type OutboxServiceOptions = {
  db: Db;
  cipher: Cipher;
  publicUrl: string;
  transportFactory?: TransportFactory;
  pollMs?: number;
};

export function createOutboxService(opts: OutboxServiceOptions) {
  const { db, cipher } = opts;
  const publicUrl = opts.publicUrl.replace(/\/$/, "");
  const getTransport = (account: Account) => (opts.transportFactory ?? defaultTransportFactory)(account, cipher);
  const pollMs = opts.pollMs ?? 500;

  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;
  const cleanupTimers = new Set<ReturnType<typeof setTimeout>>();

  function scheduleDelayedCleanup(args: {
    accountEmail: string;
    sentMessageIds: string[];
    recipientTokens: string[];
    keepMessageId: string;
    sentAt: number;
    remaining: number;
  }) {
    const delays = [15_000, 45_000];
    let left = args.remaining;
    let idx = 0;

    const runStep = () => {
      if (left <= 0 || idx >= delays.length) return;
      const delay = delays[idx++];
      const t = setTimeout(() => {
        cleanupTimers.delete(t);
        const account = db.getAccount(args.accountEmail);
        if (!account) return;
        const transport = getTransport(account);
        if (!transport.cleanupSentCopies) return;
        void transport
          .cleanupSentCopies({
            sentMessageIds: args.sentMessageIds,
            recipientTokens: args.recipientTokens,
            keepMessageId: args.keepMessageId,
            sentAt: args.sentAt,
          })
          .then((cleaned) => {
            left = Math.max(0, left - cleaned);
            if (left > 0) {
              if (idx < delays.length) runStep();
              else {
                console.warn(
                  `[open-mailtrack] ${left} duplicate sent copy(s) still not found for ${args.accountEmail} after delayed sweep`,
                );
              }
            }
          })
          .catch((err) => {
            console.error(`[open-mailtrack] delayed sent copy cleanup failed:`, err);
          });
      }, delay);
      t.unref?.();
      cleanupTimers.add(t);
    };

    runStep();
  }

  async function processItem(item: OutboxItem): Promise<{ gmailMessageId: string; gmailThreadId: string }> {
    try {
      const account = db.getAccount(item.account_email);
      if (!account) {
        throw new OutboxError(412, `Account ${item.account_email} is no longer connected`);
      }
      if (!item.payload_encrypted) {
        throw new OutboxError(500, "Outbox payload missing");
      }

      const payload = JSON.parse(cipher.decrypt(item.payload_encrypted)) as OutboxPayload;
      const transport = getTransport(account);
      const tokens = db.listRecipientTokens(item.message_id);
      const senderEmail = account.email.toLowerCase();
      const domain = senderEmail.split("@")[1] || "gmail.com";
      const sentAt = Date.now();
      const sentDate = new Date(sentAt);
      const cleanMessageId = `<${item.message_id}@${domain}>`;

      // For brand-new group emails, link copies to cleanMessageId via References so Reply-All threads cleanly.
      const recipientReferences = payload.references || (tokens.length > 1 ? cleanMessageId : undefined);
      const sentMessageIds: string[] = [];
      const anyAlreadySent = tokens.some((t) => t.sent_at !== null);

      for (const t of tokens) {
        // Checkpoint: never re-send to a recipient whose SMTP copy Gmail already accepted.
        if (t.sent_at !== null) {
          if (t.smtp_message_id) sentMessageIds.push(t.smtp_message_id);
          continue;
        }
        const msgId = `<${t.token}@${domain}>`;
        const pixelUrl = `${publicUrl}/p/${t.token}.gif`;
        const html = injectPixelIntoHtml(payload.html, pixelUrl);
        const raw = await compileMime({
          from: payload.from,
          to: payload.to,
          cc: payload.cc,
          subject: payload.subject,
          html,
          text: payload.text,
          inReplyTo: payload.inReplyTo,
          references: recipientReferences,
          messageId: msgId,
          date: sentDate,
          attachments: payload.attachments,
        });
        await transport.sendSmtpCopy(senderEmail, t.recipient, raw);
        db.markRecipientTokenSent(t.token, msgId, Date.now());
        sentMessageIds.push(msgId);
      }

      if (payload.includeSelfDelivery && !anyAlreadySent) {
        const selfMsgId = `<${newTokenId()}@${domain}>`;
        const raw = await compileMime({
          from: payload.from,
          to: payload.to,
          cc: payload.cc,
          subject: payload.subject,
          html: payload.html,
          text: payload.text,
          inReplyTo: payload.inReplyTo,
          references: recipientReferences,
          messageId: selfMsgId,
          date: sentDate,
          attachments: payload.attachments,
        });
        await transport.sendSmtpCopy(senderEmail, senderEmail, raw);
        sentMessageIds.push(selfMsgId);
      }

      const cleanRaw = await compileMime({
        from: payload.from,
        to: payload.to,
        cc: payload.cc,
        includeBccHeader: payload.bcc,
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
        inReplyTo: payload.inReplyTo,
        references: payload.references,
        messageId: cleanMessageId,
        date: sentDate,
        attachments: payload.attachments,
      });

      const gmail = await transport.replaceSentCopies({
        sentMessageIds,
        recipientTokens: tokens.map((t) => t.token),
        subject: payload.subject,
        cleanRaw,
        threadId: item.thread_id,
        sentAt,
      });

      if (
        gmail.cleanedCopies !== undefined &&
        gmail.expectedCopies !== undefined &&
        gmail.cleanedCopies < gmail.expectedCopies &&
        transport.cleanupSentCopies
      ) {
        scheduleDelayedCleanup({
          accountEmail: item.account_email,
          sentMessageIds,
          recipientTokens: tokens.map((t) => t.token),
          keepMessageId: gmail.gmailMessageId,
          sentAt,
          remaining: gmail.expectedCopies - gmail.cleanedCopies,
        });
      }

      db.completeOutboxSent(
        item.id,
        item.message_id,
        { messageId: gmail.gmailMessageId, threadId: gmail.gmailThreadId },
        sentAt,
      );
      return gmail;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      db.failOutbox(item.id, msg);
      throw err;
    }
  }

  function drainDue(): Promise<void> {
    if (inFlight) return inFlight;
    const p = (async () => {
      // Yield once so `inFlight = p` is assigned before `finally` can ever run on an empty queue.
      await Promise.resolve();
      while (true) {
        const item = db.claimOneDueOutbox(Date.now());
        if (!item) break;
        try {
          await processItem(item);
        } catch (err) {
          console.error(`[open-mailtrack] outbox ${item.id} failed:`, err);
        }
      }
    })().finally(() => {
      if (inFlight === p) inFlight = null;
    });
    inFlight = p;
    return p;
  }

  return {
    async enqueue(req: EnqueueRequest) {
      const senderEmail = extractEmailAddress(req.sender);
      if (!senderEmail) {
        throw new OutboxError(400, "Valid sender email address is required");
      }

      // Idempotency guard for retries after a lost HTTP response.
      if (req.clientRequestId) {
        const existing = db.getOutboxByClientRequestId(senderEmail, req.clientRequestId);
        if (existing) {
          return {
            outboxId: existing.id,
            messageId: existing.message_id,
            sendAt: existing.send_at,
            remainingMs: Math.max(0, existing.send_at - Date.now()),
            status: existing.status,
          };
        }
      }

      const account = db.getAccount(senderEmail);
      if (!account) {
        throw new OutboxError(412, `Account ${senderEmail} is not connected. Connect it in open-mailtrack options first.`);
      }

      const to = (req.to ?? []).filter(Boolean);
      const cc = (req.cc ?? []).filter(Boolean);
      const bcc = (req.bcc ?? []).filter(Boolean);

      const seen = new Set<string>();
      const tracked: { email: string; kind: RecipientKind }[] = [];
      let includeSelfDelivery = false;

      const addList = (list: string[], kind: RecipientKind) => {
        for (const entry of list) {
          const email = extractEmailAddress(entry);
          if (!email) continue;
          if (email === senderEmail) {
            includeSelfDelivery = true;
            continue;
          }
          if (seen.has(email)) continue;
          seen.add(email);
          tracked.push({ email, kind });
        }
      };
      addList(to, "to");
      addList(cc, "cc");
      addList(bcc, "bcc");

      if (tracked.length === 0) {
        throw new OutboxError(400, "At least one recipient other than yourself is required for tracking");
      }
      const source = req.source ?? "extension";
      if (source === "extension" && tracked.length > MAX_GROUP_RECIPIENTS) {
        throw new OutboxError(
          400,
          `Per-recipient tracking is capped at ${MAX_GROUP_RECIPIENTS} recipients in Gmail compose (found ${tracked.length}). Turn tracking off for this message or use openmt CLI.`,
        );
      }

      const transport = getTransport(account);
      let attachments: MimeAttachment[] = [...(req.attachments ?? [])];
      let inReplyTo = req.inReplyTo;
      let references = req.references;
      let threadId = req.threadId ?? null;

      if (req.draftId || req.draftMessageId) {
        try {
          const attempts = req.hasAttachments && attachments.length === 0 ? [0, 600, 1200, 1800] : [0];
          let draft: { raw: Buffer; threadId?: string } | null = null;
          let parsed: Awaited<ReturnType<typeof parseDraftMime>> | null = null;
          for (const waitMs of attempts) {
            if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
            draft = await transport.getDraftRaw(req.draftId, req.draftMessageId);
            if (!draft) continue;
            parsed = await parseDraftMime(draft.raw);
            if (!req.hasAttachments || parsed.attachments.length > 0) break;
          }
          if (draft && parsed) {
            if (attachments.length === 0 && parsed.attachments.length > 0) {
              attachments = parsed.attachments;
            }
            inReplyTo ??= parsed.inReplyTo;
            references ??= parsed.references;
            if (parsed.inReplyTo) threadId ??= draft.threadId ?? null;
          }
          if (req.hasAttachments && attachments.length === 0) {
            throw new OutboxError(
              502,
              "Could not read draft attachments from Gmail yet; wait a second for Gmail to finish saving the draft and retry.",
            );
          }
        } catch (err) {
          if (err instanceof OutboxError) throw err;
          throw new OutboxError(502, `Could not read Gmail draft attachments: ${(err as Error).message}`);
        }
      } else if (req.hasAttachments && attachments.length === 0) {
        throw new OutboxError(
          502,
          "Draft has attachments that Gmail has not saved yet; wait a second for Gmail to save the draft and retry.",
        );
      }

      if (threadId && !inReplyTo) {
        try {
          const replyHeaders = await transport.getThreadReplyHeaders(threadId);
          if (replyHeaders) {
            inReplyTo = replyHeaders.inReplyTo;
            references = replyHeaders.references;
          }
        } catch (err) {
          throw new OutboxError(502, `Could not fetch thread headers for reply: ${(err as Error).message}`);
        }
      }

      const cleanHtml = stripServerPixelsFromHtml(req.html, publicUrl);
      const from = req.from || (account.display_name ? `${account.display_name} <${senderEmail}>` : senderEmail);
      const messageId = newTokenId();
      const outboxId = newTokenId();
      // Compute sendAt AFTER draft snapshot so the Undo window starts when the HTTP response returns.
      const now = Date.now();
      const isScheduled = Boolean(req.isScheduled || (req.sendAt !== undefined && req.sendAt > now + 60_000));
      const sendAt = req.sendAt ?? (now + Math.max(0, req.undoDelayMs ?? 0));

      const recipientTokens = tracked.map((r) => ({
        token: newTokenId(),
        message_id: messageId,
        recipient: r.email,
        kind: r.kind,
      }));

      const payload: OutboxPayload = {
        from,
        to,
        cc,
        bcc,
        subject: req.subject,
        html: cleanHtml,
        text: req.text,
        inReplyTo,
        references,
        attachments,
        source,
        includeSelfDelivery,
      };
      const payloadEncrypted = cipher.encrypt(JSON.stringify(payload));

      db.createMessageWithOutbox({
        message: {
          id: messageId,
          sender: senderEmail,
          recipients: tracked.map((r) => r.email),
          subject: req.subject,
          source,
          tracking_mode: "per_recipient",
        },
        tokens: recipientTokens,
        outbox: {
          id: outboxId,
          account_email: senderEmail,
          message_id: messageId,
          client_request_id: req.clientRequestId ?? null,
          send_at: sendAt,
          is_scheduled: isScheduled,
          subject: req.subject,
          recipients: { to, cc, bcc },
          thread_id: threadId,
          draft_id: req.draftId ?? req.draftMessageId ?? null,
          payload_encrypted: payloadEncrypted,
        },
      });

      if (req.draftId || req.draftMessageId) {
        await transport.deleteDraft(req.draftId, req.draftMessageId).catch((err) => {
          console.error(`[open-mailtrack] non-fatal draft cleanup failed:`, err);
        });
      }

      if (req.sync) {
        const mine = db.claimOutboxById(outboxId);
        if (!mine) {
          throw new OutboxError(409, "Outbox item was claimed or canceled before synchronous dispatch");
        }
        const gmail = await processItem(mine);
        return {
          outboxId,
          messageId,
          sendAt,
          remainingMs: 0,
          status: "sent" as const,
          gmailMessageId: gmail.gmailMessageId,
          gmailThreadId: gmail.gmailThreadId,
        };
      }

      if (sendAt <= Date.now()) {
        void drainDue();
      }

      return {
        outboxId,
        messageId,
        sendAt,
        remainingMs: Math.max(0, sendAt - Date.now()),
        status: "queued" as const,
      };
    },

    async cancel(outboxId: string, restoreDraft = true) {
      const existing = db.getOutbox(outboxId);
      if (!existing) throw new OutboxError(404, "Outbox item not found");
      if (existing.status === "sending" || existing.status === "sent" || existing.status === "canceling") {
        throw new OutboxError(409, `Cannot cancel message that is already ${existing.status}`);
      }
      if (existing.status === "canceled") {
        return { canceled: true, draftId: null as string | null, draftMessageId: null as string | null };
      }

      // Never cancel if one or more recipients already received their SMTP copy.
      const deliveredCount = db.listRecipientTokens(existing.message_id).filter((t) => t.sent_at !== null).length;
      if (deliveredCount > 0) {
        throw new OutboxError(
          409,
          `Already delivered to ${deliveredCount} recipient(s); retry instead of canceling so tracking and remaining deliveries complete.`,
        );
      }

      const locked = db.beginCancelOutbox(outboxId);
      if (!locked) {
        throw new OutboxError(409, "Message started sending before it could be canceled");
      }

      let draftId: string | null = null;
      let draftMessageId: string | null = null;

      try {
        if (restoreDraft) {
          if (!locked.item.payload_encrypted) {
            throw new OutboxError(500, "Outbox snapshot is missing and cannot be restored");
          }
          const account = db.getAccount(locked.item.account_email);
          if (!account) {
            throw new OutboxError(412, `Account ${locked.item.account_email} is disconnected; reconnect it to restore the draft.`);
          }
          const payload = JSON.parse(cipher.decrypt(locked.item.payload_encrypted)) as OutboxPayload;
          const domain = account.email.split("@")[1] || "gmail.com";
          const raw = await compileMime({
            from: payload.from,
            to: payload.to,
            cc: payload.cc,
            includeBccHeader: payload.bcc,
            subject: payload.subject,
            html: payload.html,
            text: payload.text,
            inReplyTo: payload.inReplyTo,
            references: payload.references,
            messageId: `<draft-${locked.item.id}@${domain}>`,
            attachments: payload.attachments,
          });
          const restored = await getTransport(account).createDraft(raw, locked.item.thread_id);
          if (!restored.draftId && !restored.messageId) {
            throw new OutboxError(502, "Gmail did not confirm draft restoration");
          }
          draftId = restored.draftId || null;
          draftMessageId = restored.messageId || null;
        }
      } catch (err) {
        // Restore previous status with encrypted snapshot completely intact!
        db.abortCancelOutbox(outboxId, locked.previousStatus);
        throw err;
      }

      // Only purge the snapshot and tracking rows AFTER Gmail confirmed draft restoration.
      db.finishCancelOutbox(outboxId, locked.item.message_id);
      return { canceled: true, draftId, draftMessageId };
    },

    async reschedule(outboxId: string, sendAt: number) {
      const existing = db.getOutbox(outboxId);
      if (!existing) throw new OutboxError(404, "Outbox item not found");
      if (!db.rescheduleOutbox(outboxId, sendAt)) {
        throw new OutboxError(409, `Cannot reschedule message in status ${existing.status}`);
      }
      if (sendAt <= Date.now()) {
        void drainDue();
      }
      return { outboxId, sendAt, status: "queued" as const };
    },

    drainDue,

    start() {
      db.recoverStuckSending(0);
      timer = setInterval(() => void drainDue(), pollMs);
      timer.unref?.();
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      for (const t of cleanupTimers) clearTimeout(t);
      cleanupTimers.clear();
    },

    async stopAndDrain() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      for (const t of cleanupTimers) clearTimeout(t);
      cleanupTimers.clear();
      if (inFlight) {
        await inFlight.catch(() => {});
      }
    },
  };
}

export type OutboxService = ReturnType<typeof createOutboxService>;
