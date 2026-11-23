import { describe, expect, it } from "vitest";
import { AppleRelayMatcher, createAppleRelayStore } from "./apple-mpp.js";
import { createApp } from "./app.js";
import { openDb } from "./db.js";
import type { MailboxTransport, ReplaceSentArgs } from "./mailbox.js";
import { compileMime, parseDraftMime } from "./mime.js";

const auth = { authorization: "Bearer secret", "content-type": "application/json" };

function createMockTransport(email: string, opts: { failSmtp?: boolean; draftRaw?: Buffer; replyHeaders?: { inReplyTo: string; references: string } } = {}) {
  const smtpCopies: { from: string; to: string; raw: Buffer }[] = [];
  const replaced: ReplaceSentArgs[] = [];
  const deletedDrafts: string[] = [];
  const createdDrafts: { raw: Buffer; threadId?: string | null }[] = [];
  let seq = 0;

  const transport: MailboxTransport = {
    email,
    async verify() {},
    async getThreadReplyHeaders() {
      return opts.replyHeaders ?? null;
    },
    async getDraftRaw() {
      return opts.draftRaw ? { raw: opts.draftRaw, threadId: "gt-reply" } : null;
    },
    async deleteDraft(draftId: string) {
      deletedDrafts.push(draftId);
    },
    async createDraft(raw: Buffer, threadId?: string | null) {
      createdDrafts.push({ raw, threadId });
      seq++;
      return { draftId: `draft-${seq}`, messageId: `dmsg-${seq}` };
    },
    async sendSmtpCopy(envelopeFrom: string, envelopeTo: string, raw: Buffer) {
      if (opts.failSmtp) throw new Error("SMTP 550 temporary failure");
      smtpCopies.push({ from: envelopeFrom, to: envelopeTo, raw });
    },
    async replaceSentCopies(args: ReplaceSentArgs) {
      replaced.push(args);
      seq++;
      return { gmailMessageId: `gm-clean-${seq}`, gmailThreadId: args.threadId ?? `gt-clean-${seq}` };
    },
  };

  return { transport, smtpCopies, replaced, deletedDrafts, createdDrafts };
}

function setup(mock?: ReturnType<typeof createMockTransport>) {
  const db = openDb(":memory:");
  const appleRelay = createAppleRelayStore();
  appleRelay.setMatcher(AppleRelayMatcher.fromCsv("172.224.224.0/24,US,CA,San Jose,"));
  const m = mock ?? createMockTransport("me@cornell.edu");
  const app = createApp(db, {
    apiKey: "secret",
    publicUrl: "https://t.example.com",
    appleRelay,
    transportFactory: () => m.transport,
  });
  return { db, app, mock: m };
}

describe("unified outbox, per-recipient tracking, Apple MPP, and contacts", () => {
  it("delivers per-recipient SMTP copies, inserts pixel-free Sent copy with Bcc, and attributes opens per recipient", async () => {
    const { db, app, mock } = setup();

    // Connect account via app-password endpoint
    const accRes = await app.request("/api/accounts/app-password", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ email: "me@cornell.edu", appPassword: "abcd efgh ijkl mnop", displayName: "Charlie" }),
    });
    expect(accRes.status).toBe(201);

    // Confirm secrets are never exposed via GET /api/accounts
    const listAcc = await (await app.request("/api/accounts", { headers: auth })).json();
    expect(listAcc.accounts).toHaveLength(1);
    expect(listAcc.accounts[0].email).toBe("me@cornell.edu");
    expect(JSON.stringify(listAcc)).not.toContain("abcd");

    // Enqueue a group email synchronously (To: alice, Cc: bob, Bcc: carol)
    const sendRes = await app.request("/api/outbox", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        sender: "me@cornell.edu",
        to: ["alice@example.com"],
        cc: ["bob@example.com"],
        bcc: ["carol@example.com"],
        subject: "Q3 Plan",
        html: "<p>Hello everyone</p>",
        sync: true,
      }),
    });
    expect(sendRes.status).toBe(201);
    const sent = await sendRes.json();
    expect(sent.status).toBe("sent");
    expect(sent.gmailMessageId).toBe("gm-clean-1");

    // Verify 3 distinct SMTP copies with separate RCPT TO envelopes and unique pixels, NO Bcc header leaked
    expect(mock.smtpCopies).toHaveLength(3);
    expect(mock.smtpCopies.map((c) => c.to)).toEqual(["alice@example.com", "bob@example.com", "carol@example.com"]);
    const tokensByRecipient: Record<string, string> = {};
    for (const copy of mock.smtpCopies) {
      const str = copy.raw.toString("utf8");
      expect(str).toContain("To: alice@example.com");
      expect(str).toContain("Cc: bob@example.com");
      expect(str).not.toContain("carol@example.com"); // Bcc never leaked in MIME headers!
      const parsed = await parseDraftMime(copy.raw);
      const match = /https:\/\/t\.example\.com\/p\/([A-Za-z0-9_-]{22})\.gif/.exec(parsed.html ?? "");
      expect(match).not.toBeNull();
      tokensByRecipient[copy.to] = match![1];
    }
    expect(new Set(Object.values(tokensByRecipient)).size).toBe(3);

    // Verify clean Sent copy has NO pixel and DOES retain Bcc header
    expect(mock.replaced).toHaveLength(1);
    const cleanStr = mock.replaced[0].cleanRaw.toString("utf8");
    expect(cleanStr).not.toContain("t.example.com/p/");
    expect(cleanStr).toContain("Bcc: carol@example.com");

    // Payload must be purged from outbox after sending!
    expect(db.getOutbox(sent.outboxId)!.payload_encrypted).toBeNull();

    // Alice opens via direct browser (confirmed open)
    await app.request(`/p/${tokensByRecipient["alice@example.com"]}.gif`, {
      headers: { "user-agent": "Mozilla/5.0 (Macintosh) Chrome/125", "cf-connecting-ip": "8.8.8.8" },
    });
    // Bob's email is prefetched by Apple Mail Privacy Protection
    await app.request(`/p/${tokensByRecipient["bob@example.com"]}.gif`, {
      headers: { "user-agent": "Mozilla/5.0", "cf-connecting-ip": "172.224.224.12" },
    });

    // Check /api/status
    const status = await (
      await app.request(`/api/status?messageIds=${sent.gmailMessageId}&threadIds=${sent.gmailThreadId}`, { headers: auth })
    ).json();
    const msgSummary = status.messages[sent.gmailMessageId];
    expect(msgSummary.opens).toBe(1);
    expect(msgSummary.appleMpp).toBe(1);
    expect(msgSummary.trackingMode).toBe("per_recipient");
    expect(msgSummary.recipientSummaries).toHaveLength(3);
    expect(msgSummary.recipientSummaries.find((r: { recipient: string }) => r.recipient === "alice@example.com")).toMatchObject({
      opens: 1,
      appleMpp: 0,
    });
    expect(msgSummary.recipientSummaries.find((r: { recipient: string }) => r.recipient === "bob@example.com")).toMatchObject({
      opens: 0,
      appleMpp: 1,
    });
    expect(msgSummary.recipientSummaries.find((r: { recipient: string }) => r.recipient === "carol@example.com")).toMatchObject({
      opens: 0,
      appleMpp: 0,
    });

    // Check thread summary
    expect(status.threads[sent.gmailThreadId]).toMatchObject({
      tracked: 1,
      opens: 1,
      appleMpp: 1,
      recipientCount: 3,
      openedRecipients: 1,
      openedRecipientEmails: ["alice@example.com"],
    });

    // Check /api/contacts and /api/contacts/:email
    const contactsRes = await (await app.request("/api/contacts?sender=me@cornell.edu", { headers: auth })).json();
    expect(contactsRes.total).toBe(3);
    const aliceContact = await (
      await app.request("/api/contacts/alice%40example.com?sender=me@cornell.edu", { headers: auth })
    ).json();
    expect(aliceContact.contact).toMatchObject({
      email: "alice@example.com",
      messages: 1,
      attributableMessages: 1,
      openedMessages: 1,
      totalOpens: 1,
    });
    expect(aliceContact.messages[0]).toMatchObject({ attribution: "individual", opens: 1 });

    const bobContact = await (
      await app.request("/api/contacts/bob%40example.com?sender=me@cornell.edu", { headers: auth })
    ).json();
    expect(bobContact.contact).toMatchObject({
      email: "bob@example.com",
      openedMessages: 0,
      appleMppMessages: 1,
    });
  });

  it("supports Undo Send and Schedule Send cancellation with Gmail draft restoration, plus reschedule/send-now", async () => {
    const draftRaw = await compileMime({
      from: "me@cornell.edu",
      to: ["alice@example.com"],
      subject: "Draft with file",
      html: "<p>Old text</p>",
      messageId: "<draft-orig@cornell.edu>",
      attachments: [
        {
          filename: "deck.pdf",
          contentType: "application/pdf",
          contentBase64: Buffer.from("%PDF-1.4 test").toString("base64"),
        },
      ],
    });
    const mock = createMockTransport("me@cornell.edu", {
      draftRaw,
      replyHeaders: { inReplyTo: "<parent@example.com>", references: "<root@example.com> <parent@example.com>" },
    });
    const { db, app } = setup(mock);

    await app.request("/api/accounts/app-password", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ email: "me@cornell.edu", appPassword: "secret" }),
    });

    // Queue with a 60s delay (simulating Undo Send or Schedule Send)
    const future = Date.now() + 60_000;
    const queued = await (
      await app.request("/api/outbox", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          sender: "me@cornell.edu",
          to: ["alice@example.com"],
          subject: "Draft with file",
          html: "<p>Latest keystroke text</p>",
          threadId: "gt-reply",
          draftId: "draft-orig",
          sendAt: future,
          isScheduled: true,
        }),
      })
    ).json();
    expect(queued.status).toBe("queued");
    expect(mock.deletedDrafts).toEqual(["draft-orig"]);

    // Queued outbox message must NOT appear in /api/messages yet
    const listMsgs = await (await app.request("/api/messages?sender=me@cornell.edu", { headers: auth })).json();
    expect(listMsgs.total).toBe(0);

    // Appears in /api/outbox
    const listOutbox = await (await app.request("/api/outbox?sender=me@cornell.edu", { headers: auth })).json();
    expect(listOutbox.items).toHaveLength(1);
    expect(listOutbox.items[0].isScheduled).toBe(true);

    // Cancel and verify draft is restored with latest HTML + preserved attachment + reply headers
    const cancelRes = await (
      await app.request(`/api/outbox/${queued.outboxId}`, { method: "DELETE", headers: auth })
    ).json();
    expect(cancelRes).toMatchObject({ canceled: true, draftId: "draft-1", draftMessageId: "dmsg-1" });
    expect(mock.createdDrafts).toHaveLength(1);
    const restoredParsed = await parseDraftMime(mock.createdDrafts[0].raw);
    expect(restoredParsed.html).toContain("Latest keystroke text");
    expect(restoredParsed.attachments).toHaveLength(1);
    expect(restoredParsed.attachments[0].filename).toBe("deck.pdf");
    expect(restoredParsed.inReplyTo).toBe("<parent@example.com>");
    // Unsent message record cleaned up and payload purged
    expect(db.getMessage(queued.messageId)).toBeNull();
    expect(db.getOutbox(queued.outboxId)!.payload_encrypted).toBeNull();

    // Now test reschedule -> Send Now
    const queued2 = await (
      await app.request("/api/outbox", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          sender: "me@cornell.edu",
          to: ["alice@example.com"],
          subject: "Scheduled email",
          html: "<p>Later</p>",
          sendAt: Date.now() + 3_600_000,
          isScheduled: true,
        }),
      })
    ).json();
    const resched = await app.request(`/api/outbox/${queued2.outboxId}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ sendAt: Date.now() - 1000 }),
    });
    expect(resched.status).toBe(200);
    await app.outbox.drainDue();
    expect(db.getOutbox(queued2.outboxId)!.status).toBe("sent");
    expect(mock.smtpCopies).toHaveLength(1);
  });

  it("enforces the 25-recipient cap, fails closed when unconnected, and labels legacy group messages as group_unknown", async () => {
    const { app } = setup();

    // Unconnected account fails closed with 412
    const unconn = await app.request("/api/outbox", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        sender: "unconnected@gmail.com",
        to: ["a@example.com"],
        subject: "Hi",
        html: "<p>Hi</p>",
      }),
    });
    expect(unconn.status).toBe(412);

    // Connect and test 26-recipient cap
    await app.request("/api/accounts/app-password", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ email: "me@cornell.edu", appPassword: "secret" }),
    });
    const tooMany = Array.from({ length: 26 }, (_, i) => `u${i}@example.com`);
    const capRes = await app.request("/api/outbox", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        sender: "me@cornell.edu",
        to: tooMany,
        subject: "Big group",
        html: "<p>Hi all</p>",
      }),
    });
    expect(capRes.status).toBe(400);
    expect((await capRes.json()).error).toContain("25");

    // Legacy multi-recipient message should NOT inflate individual open rate in /api/contacts
    const legacy = await (
      await app.request("/api/messages", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          sender: "me@cornell.edu",
          recipients: ["alice@example.com", "bob@example.com"],
          subject: "Old group mail",
          source: "extension",
        }),
      })
    ).json();
    await app.request(`/p/${legacy.id}.gif`, { headers: { "user-agent": "Chrome/120" } });
    const alice = await (
      await app.request("/api/contacts/alice%40example.com?sender=me@cornell.edu", { headers: auth })
    ).json();
    expect(alice.contact).toMatchObject({
      messages: 1,
      attributableMessages: 0,
      openedMessages: 0,
      totalOpens: 0,
    });
    expect(alice.messages[0]).toMatchObject({ attribution: "group_unknown", opens: 1 });
  });

  it("keeps polling after an idle drainDue() call (regression for empty-queue latch bug)", async () => {
    const { db, app, mock } = setup();
    await app.request("/api/accounts/app-password", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ email: "me@cornell.edu", appPassword: "secret" }),
    });

    // First poll on an empty queue must NOT permanently latch inFlight.
    await app.outbox.drainDue();

    const queued = await (
      await app.request("/api/outbox", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          sender: "me@cornell.edu",
          to: ["alice@example.com"],
          subject: "After idle poll",
          html: "<p>Works</p>",
          sendAt: Date.now() - 1000,
        }),
      })
    ).json();

    await app.outbox.drainDue();
    expect(db.getOutbox(queued.outboxId)!.status).toBe("sent");
    expect(mock.smtpCopies).toHaveLength(1);
  });

  it("preserves outbox snapshot when Gmail draft restore fails on cancel, then succeeds on retry", async () => {
    let failCreateDraft = true;
    const base = createMockTransport("me@cornell.edu");
    const transport: MailboxTransport = {
      ...base.transport,
      async createDraft(raw, threadId) {
        if (failCreateDraft) throw new Error("Gmail 503 unavailable");
        return base.transport.createDraft(raw, threadId);
      },
    };
    const db = openDb(":memory:");
    const app = createApp(db, {
      apiKey: "secret",
      publicUrl: "https://t.example.com",
      encryptionKey: "", // empty env var must safely fall back to apiKey!
      transportFactory: () => transport,
    });
    await app.request("/api/accounts/app-password", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ email: "me@cornell.edu", appPassword: "secret" }),
    });

    const queued = await (
      await app.request("/api/outbox", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          sender: "me@cornell.edu",
          to: ["alice@example.com"],
          subject: "Keep safe",
          html: "<p>Do not lose me</p>",
          sendAt: Date.now() + 60_000,
        }),
      })
    ).json();

    // First cancel fails in Gmail -> snapshot and message MUST stay intact!
    const failedCancel = await app.request(`/api/outbox/${queued.outboxId}`, { method: "DELETE", headers: auth });
    expect(failedCancel.status).toBe(500);
    const preserved = db.getOutbox(queued.outboxId)!;
    expect(preserved.status).toBe("queued");
    expect(preserved.payload_encrypted).not.toBeNull();
    expect(db.getMessage(queued.messageId)).not.toBeNull();

    // Retry cancel once Gmail recovers -> draft restored and snapshot purged!
    failCreateDraft = false;
    const okCancel = await app.request(`/api/outbox/${queued.outboxId}`, { method: "DELETE", headers: auth });
    expect(okCancel.status).toBe(200);
    expect(await okCancel.json()).toMatchObject({ canceled: true, draftId: "draft-1" });
    expect(db.getOutbox(queued.outboxId)!.status).toBe("canceled");
    expect(db.getOutbox(queued.outboxId)!.payload_encrypted).toBeNull();
  });

  it("checkpoints per-recipient delivery so retry never resends already-accepted recipients", async () => {
    let failBob = true;
    const base = createMockTransport("me@cornell.edu");
    const transport: MailboxTransport = {
      ...base.transport,
      async sendSmtpCopy(from, to, raw) {
        if (to === "bob@example.com" && failBob) throw new Error("Bob temporary 451");
        return base.transport.sendSmtpCopy(from, to, raw);
      },
    };
    const db = openDb(":memory:");
    const app = createApp(db, { apiKey: "secret", publicUrl: "https://t.example.com", transportFactory: () => transport });
    await app.request("/api/accounts/app-password", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ email: "me@cornell.edu", appPassword: "secret" }),
    });

    const queued = await (
      await app.request("/api/outbox", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          sender: "me@cornell.edu",
          to: ["alice@example.com", "bob@example.com"],
          subject: "Partial",
          html: "<p>Hi</p>",
          sendAt: Date.now() - 1000,
        }),
      })
    ).json();

    await app.outbox.drainDue();
    expect(db.getOutbox(queued.outboxId)!.status).toBe("failed");
    expect(base.smtpCopies.map((c) => c.to)).toEqual(["alice@example.com"]);

    // Canceling a partially delivered send must be rejected so Alice's tracking is not erased.
    const cancelRes = await app.request(`/api/outbox/${queued.outboxId}`, { method: "DELETE", headers: auth });
    expect(cancelRes.status).toBe(409);

    // Retry must ONLY deliver to Bob, NEVER resend to Alice!
    failBob = false;
    await app.request(`/api/outbox/${queued.outboxId}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ sendAt: Date.now() - 1000 }),
    });
    await app.outbox.drainDue();
    expect(db.getOutbox(queued.outboxId)!.status).toBe("sent");
    expect(base.smtpCopies.map((c) => c.to)).toEqual(["alice@example.com", "bob@example.com"]);
  });

  it("does not strand unrelated due scheduled items on sync:true sends, and validates payloads and addresses", async () => {
    const { db, app, mock } = setup();
    await app.request("/api/accounts/app-password", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ email: "me@cornell.edu", appPassword: "secret" }),
    });

    // Reject object in `text` (prevents MailComposer file/URL path access)
    const badText = await app.request("/api/outbox", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        sender: "me@cornell.edu",
        to: ["alice@example.com"],
        subject: "Bad",
        html: "<p>Hi</p>",
        text: { path: "/etc/passwd" },
      }),
    });
    expect(badText.status).toBe(400);

    // Reject missing attachments draft fail-closed
    const badAtt = await app.request("/api/outbox", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        sender: "me@cornell.edu",
        to: ["alice@example.com"],
        subject: "Has file",
        html: "<p>See attached</p>",
        hasAttachments: true,
      }),
    });
    expect(badAtt.status).toBe(502);

    // Queue an unrelated scheduled email that is already due
    const sched = await (
      await app.request("/api/outbox", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          sender: "me@cornell.edu",
          to: ["scheduled@example.com"],
          subject: "Scheduled",
          html: "<p>Later</p>",
          sendAt: Date.now() + 60_000,
          isScheduled: true,
        }),
      })
    ).json();
    // Make it due without draining yet
    db.rescheduleOutbox(sched.outboxId, Date.now() - 5000);

    // Send a sync:true CLI email with a tricky display name containing <evil@attacker.com>
    const cli = await (
      await app.request("/api/outbox", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          sender: "me@cornell.edu",
          to: ['"Bob <evil@attacker.com>" <real@example.com>'],
          subject: "CLI sync",
          html: "<p>Hi</p>",
          source: "cli",
          sync: true,
          clientRequestId: "req-1",
        }),
      })
    ).json();
    expect(cli.status).toBe("sent");
    expect(mock.smtpCopies.map((c) => c.to)).toEqual(["real@example.com"]);

    // Duplicate clientRequestId returns idempotently without re-enqueuing
    const dup = await (
      await app.request("/api/outbox", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          sender: "me@cornell.edu",
          to: ["real@example.com"],
          subject: "CLI sync",
          html: "<p>Hi</p>",
          clientRequestId: "req-1",
        }),
      })
    ).json();
    expect(dup.outboxId).toBe(cli.outboxId);

    // Unrelated scheduled email MUST still be queued (not stranded in 'sending') and send cleanly on drain!
    expect(db.getOutbox(sched.outboxId)!.status).toBe("queued");
    await app.outbox.drainDue();
    expect(db.getOutbox(sched.outboxId)!.status).toBe("sent");
    expect(mock.smtpCopies.map((c) => c.to)).toEqual(["real@example.com", "scheduled@example.com"]);
  });

  it("detects replies per thread, supports follow-up dismissal, and retries briefly for delayed draft attachments", async () => {
    let draftReads = 0;
    const draftWithFile = await compileMime({
      from: "me@cornell.edu",
      to: ["alice@example.com"],
      subject: "Attachment test",
      html: "<p>File</p>",
      messageId: "<att-draft@cornell.edu>",
      attachments: [
        {
          filename: "report.pdf",
          contentType: "application/pdf",
          contentBase64: Buffer.from("%PDF-1.4 ok").toString("base64"),
        },
      ],
    });
    const base = createMockTransport("me@cornell.edu");
    const repliedThreads = new Map<string, number>();
    const transport: MailboxTransport = {
      ...base.transport,
      async getDraftRaw() {
        draftReads++;
        // First read returns null (Gmail still saving), second read returns the draft with attachment.
        return draftReads < 2 ? null : { raw: draftWithFile };
      },
      async getThreadReplyAt(threadId, sentAt) {
        const ts = repliedThreads.get(threadId);
        return ts && ts > sentAt ? ts : null;
      },
    };
    const db = openDb(":memory:");
    const app = createApp(db, { apiKey: "secret", publicUrl: "https://t.example.com", transportFactory: () => transport });
    await app.request("/api/accounts/app-password", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ email: "me@cornell.edu", appPassword: "secret" }),
    });

    const sent = await (
      await app.request("/api/outbox", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          sender: "me@cornell.edu",
          to: ["alice@example.com"],
          subject: "Attachment test",
          html: "<p>File</p>",
          draftId: "d1",
          hasAttachments: true,
          sync: true,
        }),
      })
    ).json();
    expect(sent.status).toBe("sent");
    expect(draftReads).toBe(2);
    const parsedSent = await parseDraftMime(base.smtpCopies[0].raw);
    expect(parsedSent.attachments.map((a) => a.filename)).toEqual(["report.pdf"]);

    // Before reply, reply check finds 0 replies
    const check1 = await (
      await app.request("/api/followups/refresh", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ sender: "me@cornell.edu", force: true }),
      })
    ).json();
    expect(check1).toEqual({ checked: 1, replied: 0 });
    expect(db.getMessage(sent.messageId)!.replied_at).toBeNull();

    // Simulate external reply arriving in the thread
    const replyTs = Date.now() + 5000;
    repliedThreads.set(sent.gmailThreadId, replyTs);
    const check2 = await (
      await app.request("/api/followups/refresh", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ sender: "me@cornell.edu", force: true }),
      })
    ).json();
    expect(check2).toEqual({ checked: 1, replied: 1 });
    expect(db.getMessage(sent.messageId)!.replied_at).toBe(replyTs);

    // Dismiss follow-up works and persists
    const dismissRes = await app.request(`/api/messages/${sent.messageId}/dismiss-followup`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ dismissed: true }),
    });
    expect(dismissRes.status).toBe(204);
    expect(db.getMessage(sent.messageId)!.followup_dismissed_at).not.toBeNull();
  });
});
