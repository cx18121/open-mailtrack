import { afterEach, describe, expect, it, vi } from "vitest";
import { AppleRelayMatcher, createAppleRelayStore } from "./apple-mpp.js";
import { createApp } from "./app.js";
import { openDb } from "./db.js";
import {
  classifyDsnMessage,
  createOAuthTransport,
  isBounceMessage,
  type MailboxTransport,
  type ThreadActivity,
} from "./mailbox.js";
import { compileMime } from "./mime.js";

const API_KEY = "test-secret";
const WEBHOOK = "https://discord.com/api/webhooks/123456789/abcDEF_1234567890";
const auth = { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" };

type SentWebhook = { url: string; payload: { username: string; embeds: { title: string; url?: string; color: number; fields?: { name: string; value: string }[] }[] } };

function makeFetchSpy(status = 204) {
  const calls: SentWebhook[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, payload: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(status === 204 ? null : "ok", { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function makeFakeTransport(opts: {
  activityByThread?: Map<string, ThreadActivity>;
  cleanedCopies?: number;
  onCleanup?: () => number;
} = {}): MailboxTransport {
  let seq = 0;
  return {
    email: "me@example.com",
    async verify() {},
    async getThreadReplyHeaders() {
      return null;
    },
    async inspectThreadActivity(threadId: string) {
      return (
        opts.activityByThread?.get(threadId) ?? {
          repliedAt: null,
          repliedBy: [],
          bouncedAt: null,
          bounceReason: null,
        }
      );
    },
    async getDraftRaw() {
      return null;
    },
    async deleteDraft() {},
    async createDraft() {
      return { draftId: "d1", messageId: "dm1" };
    },
    async sendSmtpCopy() {},
    async replaceSentCopies(args) {
      seq++;
      return {
        gmailMessageId: `gm_${seq}`,
        gmailThreadId: args.threadId ?? `gt_${seq}`,
        cleanedCopies: opts.cleanedCopies ?? args.sentMessageIds.length,
        expectedCopies: args.sentMessageIds.length,
      };
    },
    async cleanupSentCopies() {
      return opts.onCleanup ? opts.onCleanup() : 0;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("classifyDsnMessage and isBounceMessage", () => {
  it("detects permanent DSN bounces, ignores Gmail Delay notices, and preserves human replies", () => {
    expect(isBounceMessage({ from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", subject: "Address not found" }).bounce).toBe(true);
    expect(isBounceMessage({ from: "postmaster@company.com", subject: "Undeliverable: Hi" }).bounce).toBe(true);
    expect(isBounceMessage({ from: "nobody@x.com", failedRecipients: "bad@nowhere.test" })).toEqual({
      bounce: true,
      reason: "Delivery failed for bad@nowhere.test",
    });
    expect(isBounceMessage({ from: "noreply@x.com", contentType: 'multipart/report; report-type="delivery-status"' }).bounce).toBe(true);

    // Gmail temporary retry warning must NOT be treated as a permanent bounce OR a human reply
    const delay = classifyDsnMessage({
      from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
      subject: "Delivery Status Notification (Delay)",
      contentType: 'multipart/report; report-type="delivery-status"',
    });
    expect(delay.kind).toBe("delay");
    expect(isBounceMessage({ from: "mailer-daemon@googlemail.com", subject: "Delivery Status Notification (Delay)" }).bounce).toBe(false);

    expect(classifyDsnMessage({ from: "Alice <alice@company.com>", subject: "Re: Coffee chat" }).kind).toBe("human");
    expect(classifyDsnMessage({ from: "Alice <alice@company.com>", autoSubmitted: "auto-replied", subject: "Out of Office" }).kind).toBe("auto_reply");
    expect(classifyDsnMessage({ from: "Bob <bob@company.com>", xAutoreply: "yes", subject: "Vacation" }).kind).toBe("auto_reply");
    expect(classifyDsnMessage({ from: "Carol <carol@company.com>", precedence: "auto_reply", subject: "Away" }).kind).toBe("auto_reply");
    expect(isBounceMessage({ from: "Alice <alice@company.com>", autoSubmitted: "auto-replied", subject: "Out of Office" }).bounce).toBe(false);
  });
});

describe("Discord alerts, settings, bounce detection, and post-reply filtering", () => {
  it("validates, encrypts, masks, and tests Discord settings via /api/settings", async () => {
    const db = openDb(":memory:");
    const { calls, fetchImpl } = makeFetchSpy();
    const app = createApp(db, { apiKey: API_KEY, publicUrl: "https://t.example.com", fetchImpl });

    // Rejects non-Discord URLs (SSRF guard)
    const bad = await app.request("/api/settings", {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ discordWebhookUrl: "https://evil.example/hook" }),
    });
    expect(bad.status).toBe(400);

    const saved = await (
      await app.request("/api/settings", {
        method: "PATCH",
        headers: auth,
        body: JSON.stringify({
          discordWebhookUrl: WEBHOOK,
          digestEnabled: true,
          digestHour: 8,
          digestTimezone: "America/New_York",
          ignoredIps: ["203.0.113.5", "198.51.100.0/24"],
        }),
      })
    ).json();
    expect(saved.discordWebhookConfigured).toBe(true);
    expect(saved.discordWebhookMasked).toContain("discord.com/api/webhooks/123456789/");
    expect(saved.discordWebhookMasked).not.toContain("abcDEF_1234567890");
    // Stored encrypted in SQLite, never plaintext
    expect(db.getSetting("discord_webhook_enc")).not.toContain("abcDEF_1234567890");

    const testRes = await app.request("/api/notifications/test", { method: "POST", headers: auth, body: "{}" });
    expect(testRes.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].payload.embeds[0].title).toContain("test alert");
    db.close();
  });

  it("alerts Discord on first open, hot spike (3rd open), and revival, while ignoring Apple MPP, bots, and ignored IPs", async () => {
    const baseTime = Date.UTC(2026, 4, 1, 12, 0, 0);
    vi.spyOn(Date, "now").mockReturnValue(baseTime);

    const db = openDb(":memory:");
    const appleRelay = createAppleRelayStore();
    appleRelay.setMatcher(AppleRelayMatcher.fromCsv("172.224.224.0/24,US,US-CA,Cupertino,\n"));
    const { calls, fetchImpl } = makeFetchSpy();
    const transport = makeFakeTransport();
    const app = createApp(db, {
      apiKey: API_KEY,
      publicUrl: "https://t.example.com",
      discordWebhookUrl: WEBHOOK,
      ignoredIps: ["203.0.113.9"],
      appleRelay,
      fetchImpl,
      transportFactory: () => transport,
    });

    await app.request("/api/accounts/app-password", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ email: "me@example.com", appPassword: "abcd efgh ijkl mnop", skipVerify: true }),
    });
    const sent = await (
      await app.request("/api/outbox", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          sender: "me@example.com",
          to: ["alice@company.com"],
          subject: "Intro chat",
          html: "<p>Hello</p>",
          sync: true,
        }),
      })
    ).json();
    const token = db.listRecipientTokens(sent.messageId)[0].token;

    // 1. Non-human hits should NEVER alert Discord
    vi.spyOn(Date, "now").mockReturnValue(baseTime + 60_000);
    await app.request(`/p/${token}.gif`, { headers: { "cf-connecting-ip": "172.224.224.5", "user-agent": "Mozilla/5.0" } }); // Apple MPP
    await app.request(`/p/${token}.gif`, { headers: { "cf-connecting-ip": "1.2.3.4", "user-agent": "Slackbot-LinkExpanding" } }); // Bot
    await app.request(`/p/${token}.gif`, { headers: { "cf-connecting-ip": "203.0.113.9", "user-agent": "Mozilla/5.0 (iPhone)" } }); // Ignored IP
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(0);

    // 2. First confirmed open alerts Discord with client hint & Gmail link
    vi.spyOn(Date, "now").mockReturnValue(baseTime + 120_000);
    await app.request(`/p/${token}.gif`, { headers: { "cf-connecting-ip": "9.9.9.9", "user-agent": "Mozilla/5.0 (iPhone)" } });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(1);
    expect(calls[0].payload.embeds[0].title).toBe("Opened: Intro chat");
    expect(calls[0].payload.embeds[0].url).toContain(sent.gmailThreadId);
    expect(calls[0].payload.embeds[0].fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Recipient", value: "alice@company.com" }),
        expect.objectContaining({ name: "Client", value: "iPhone" }),
      ]),
    );

    // 3. Second open does NOT spam
    vi.spyOn(Date, "now").mockReturnValue(baseTime + 240_000);
    await app.request(`/p/${token}.gif`, { headers: { "user-agent": "GoogleImageProxy" } });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(1);

    // 4. Third open triggers Hot spike alert once
    vi.spyOn(Date, "now").mockReturnValue(baseTime + 360_000);
    await app.request(`/p/${token}.gif`, { headers: { "user-agent": "GoogleImageProxy" } });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(2);
    expect(calls[1].payload.embeds[0].title).toBe("Hot (3 opens): Intro chat");

    // 5. Reopen 4 days later triggers Revival alert once
    vi.spyOn(Date, "now").mockReturnValue(baseTime + 4 * 86_400_000);
    await app.request(`/p/${token}.gif`, { headers: { "user-agent": "GoogleImageProxy" } });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(3);
    expect(calls[2].payload.embeds[0].title).toBe("Reopened after 4d: Intro chat");

    db.close();
  });

  it("suppresses post-reply GoogleImageProxy hits per recipient in group emails and detects bounces with Discord alert", async () => {
    const baseTime = Date.UTC(2026, 4, 1, 12, 0, 0);
    vi.spyOn(Date, "now").mockReturnValue(baseTime);

    const db = openDb(":memory:");
    const { calls, fetchImpl } = makeFetchSpy();
    const activityByThread = new Map<string, ThreadActivity>();
    const transport = makeFakeTransport({ activityByThread });
    const app = createApp(db, {
      apiKey: API_KEY,
      publicUrl: "https://t.example.com",
      discordWebhookUrl: WEBHOOK,
      fetchImpl,
      transportFactory: () => transport,
    });

    await app.request("/api/accounts/app-password", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ email: "me@example.com", appPassword: "abcd efgh ijkl mnop", skipVerify: true }),
    });

    // Group email to Alice and Bob
    const groupSent = await (
      await app.request("/api/outbox", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          sender: "me@example.com",
          to: ["alice@company.com", "bob@company.com"],
          subject: "Group thread",
          html: "<p>Hi all</p>",
          sync: true,
        }),
      })
    ).json();
    const tokens = db.listRecipientTokens(groupSent.messageId);
    const aliceTok = tokens.find((t) => t.recipient === "alice@company.com")!.token;
    const bobTok = tokens.find((t) => t.recipient === "bob@company.com")!.token;

    // Bounced email to invalid@company.com
    const bounceSent = await (
      await app.request("/api/outbox", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          sender: "me@example.com",
          to: ["invalid@company.com"],
          subject: "Bad addr",
          html: "<p>Test</p>",
          sync: true,
        }),
      })
    ).json();

    const replyAt = baseTime + 60_000;
    activityByThread.set(groupSent.gmailThreadId, {
      repliedAt: replyAt,
      repliedBy: [{ email: "alice@company.com", at: replyAt }],
      bouncedAt: null,
      bounceReason: null,
    });
    activityByThread.set(bounceSent.gmailThreadId, {
      repliedAt: null,
      repliedBy: [],
      bouncedAt: baseTime + 30_000,
      bounceReason: "Delivery failed for invalid@company.com",
    });

    const refresh = await (
      await app.request("/api/followups/refresh", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ sender: "me@example.com", force: true }),
      })
    ).json();
    expect(refresh).toEqual({ checked: 2, replied: 1, bounced: 1 });
    expect(db.getMessage(bounceSent.messageId)!.replied_at).toBeNull();
    expect(db.getMessage(bounceSent.messageId)!.bounced_at).toBe(baseTime + 30_000);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.some((c) => c.payload.embeds[0].title === "Bounced: Bad addr")).toBe(true);

    // After Alice replied, a GoogleImageProxy hit on Alice's token (reading reply on mobile Gmail) is suppressed as post_reply,
    // while Bob's token still registers a confirmed open.
    vi.spyOn(Date, "now").mockReturnValue(replyAt + 120_000);
    await app.request(`/p/${aliceTok}.gif`, { headers: { "user-agent": "GoogleImageProxy" } });
    await app.request(`/p/${bobTok}.gif`, { headers: { "user-agent": "GoogleImageProxy" } });

    const detail = await (await app.request(`/api/messages/${groupSent.messageId}`, { headers: auth })).json();
    const aliceRec = detail.recipientSummaries.find((r: { recipient: string }) => r.recipient === "alice@company.com");
    const bobRec = detail.recipientSummaries.find((r: { recipient: string }) => r.recipient === "bob@company.com");
    expect(aliceRec.opens).toBe(0);
    expect(bobRec.opens).toBe(1);
    expect(detail.hits.find((h: { recipient: string }) => h.recipient === "alice@company.com").kind).toBe("post_reply");

    // Later, Bob ALSO replies (even if a third recipient bounced) — the group message is still checked,
    // Bob is merged into replied_by, and subsequent GoogleImageProxy hits on Bob's token are suppressed too.
    const bobReplyAt = replyAt + 300_000;
    activityByThread.set(groupSent.gmailThreadId, {
      repliedAt: replyAt,
      repliedBy: [
        { email: "alice@company.com", at: replyAt },
        { email: "bob@company.com", at: bobReplyAt },
      ],
      bouncedAt: replyAt + 10_000,
      bounceReason: "Delivery failed for carol@company.com",
    });
    const refresh2 = await (
      await app.request("/api/followups/refresh", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ sender: "me@example.com", force: true }),
      })
    ).json();
    expect(refresh2).toEqual({ checked: 1, replied: 1, bounced: 1 });
    expect(db.getMessage(groupSent.messageId)!.replied_by.map((r) => r.email)).toEqual([
      "alice@company.com",
      "bob@company.com",
    ]);

    vi.spyOn(Date, "now").mockReturnValue(bobReplyAt + 60_000);
    await app.request(`/p/${bobTok}.gif`, { headers: { "user-agent": "GoogleImageProxy" } });
    const detailAfterBob = await (await app.request(`/api/messages/${groupSent.messageId}`, { headers: auth })).json();
    const bobAfter = detailAfterBob.recipientSummaries.find((r: { recipient: string }) => r.recipient === "bob@company.com");
    expect(bobAfter.opens).toBe(1); // Bob's post-reply hit did NOT increment opens
    expect(detailAfterBob.hits.at(-1).kind).toBe("post_reply");
    db.close();
  });

  it("caches settings in memory for isIgnoredIp and invalidates on update", () => {
    const db = openDb(":memory:");
    const listSpy = vi.spyOn(db, "listSettings");
    const app = createApp(db, {
      apiKey: API_KEY,
      publicUrl: "https://t.example.com",
      ignoredIps: ["203.0.113.10"],
    });

    expect(app.settings.isIgnoredIp("203.0.113.10")).toBe(true);
    expect(app.settings.isIgnoredIp("203.0.113.11")).toBe(false);
    expect(app.settings.isIgnoredIp("203.0.113.10")).toBe(true);
    expect(listSpy).toHaveBeenCalledTimes(1);

    app.settings.update({ ignoredIps: ["198.51.100.0/24"] });
    expect(app.settings.isIgnoredIp("203.0.113.10")).toBe(false);
    expect(app.settings.isIgnoredIp("198.51.100.55")).toBe(true);
    expect(listSpy).toHaveBeenCalledTimes(2);
    db.close();
  });

  it("OAuth transport deduplicates trashed Sent IDs across retries, cleans Send-As alias copies, and ignores Delay DSNs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const sentAt = Date.UTC(2026, 4, 1, 12, 0, 0);
    const aliasRaw = await compileMime({
      from: "Alias <alias@customdomain.com>",
      to: ["alice@company.com"],
      subject: "Hi",
      html: '<p>Hello</p><img src="https://t.example.com/p/tok_alias_123456789012.gif">',
      messageId: "<rewritten@mail.gmail.com>",
    });
    const trashedCalls: string[] = [];
    let sentListCalls = 0;

    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      }
      if (url.endsWith("/messages?internalDateSource=dateHeader") && init?.method === "POST") {
        return new Response(JSON.stringify({ id: "clean_id", threadId: "thread_1" }), { status: 200 });
      }
      if (url.includes("rfc822msgid")) {
        // Simulate Gmail search index still returning copy_1 on EVERY iteration even after trashing!
        return new Response(JSON.stringify({ messages: [{ id: "copy_1" }] }), { status: 200 });
      }
      if (url.includes("labelIds=SENT")) {
        sentListCalls++;
        // copy_2 appears on the second iteration (delayed indexing), sent with Send-As alias
        const messages = sentListCalls === 1 ? [{ id: "clean_id" }, { id: "copy_1" }] : [{ id: "clean_id" }, { id: "copy_1" }, { id: "copy_2" }];
        return new Response(JSON.stringify({ messages }), { status: 200 });
      }
      if (url.includes("/messages/copy_2?format=raw")) {
        return new Response(
          JSON.stringify({ raw: aliasRaw.toString("base64url"), internalDate: String(sentAt + 1000) }),
          { status: 200 },
        );
      }
      if (url.endsWith("/trash") && init?.method === "POST") {
        const m = /\/messages\/([^/]+)\/trash$/.exec(url);
        if (m) trashedCalls.push(m[1]);
        return new Response(JSON.stringify({ id: m?.[1] }), { status: 200 });
      }
      if (url.includes("/threads/thread_1?format=metadata")) {
        return new Response(
          JSON.stringify({
            messages: [
              {
                internalDate: String(sentAt + 5_000),
                labelIds: ["INBOX"],
                payload: {
                  headers: [
                    { name: "From", value: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>" },
                    { name: "Subject", value: "Delivery Status Notification (Delay)" },
                  ],
                },
              },
              {
                internalDate: String(sentAt + 20_000),
                labelIds: ["INBOX"],
                payload: {
                  headers: [
                    { name: "From", value: "Alice <alice@company.com>" },
                    { name: "Subject", value: "Re: Hi" },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const transport = createOAuthTransport("me@gmail.com", {
      clientId: "cid",
      clientSecret: "csec",
      refreshToken: "rtok",
    });

    const cleanRaw = await compileMime({
      from: "Alias <alias@customdomain.com>",
      to: ["alice@company.com", "bob@company.com"],
      subject: "Hi",
      html: "<p>Hello</p>",
      messageId: "<clean@gmail.com>",
    });
    const replacePromise = transport.replaceSentCopies({
      sentMessageIds: ["<m1@gmail.com>", "<m2@gmail.com>"],
      recipientTokens: ["tok_1_1234567890123456", "tok_alias_123456789012"],
      subject: "Hi",
      cleanRaw,
      threadId: "thread_1",
      sentAt,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    const replaced = await replacePromise;

    // Must trash copy_1 once (not twice!) and find Send-As alias copy_2 on iteration 2
    expect(trashedCalls).toEqual(["copy_1", "copy_2"]);
    expect(replaced.cleanedCopies).toBe(2);
    expect(replaced.expectedCopies).toBe(2);

    // Inspect thread: Delay DSN is ignored (not bounce, not reply); Alice's human reply is detected
    const activity = await transport.inspectThreadActivity!("thread_1", sentAt, "me@gmail.com");
    expect(activity.bouncedAt).toBeNull();
    expect(activity.repliedAt).toBe(sentAt + 20_000);
    expect(activity.repliedBy).toEqual([{ email: "alice@company.com", at: sentAt + 20_000 }]);
    vi.unstubAllGlobals();
  });

  it("sends daily digest once per day after digestHour and schedules delayed Sent cleanup when initial sweep is partial", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const morning = Date.UTC(2026, 4, 2, 13, 0, 0); // 09:00 America/New_York (EDT = UTC-4)
    vi.setSystemTime(morning);

    const db = openDb(":memory:");
    const { calls, fetchImpl } = makeFetchSpy();
    let delayedSweepCalls = 0;
    const transport = makeFakeTransport({
      cleanedCopies: 0, // simulate Gmail indexing lag on initial replaceSentCopies
      onCleanup: () => {
        delayedSweepCalls++;
        return 1;
      },
    });
    const app = createApp(db, {
      apiKey: API_KEY,
      publicUrl: "https://t.example.com",
      discordWebhookUrl: WEBHOOK,
      digestHour: 9,
      digestTimezone: "America/New_York",
      fetchImpl,
      transportFactory: () => transport,
    });

    await app.request("/api/accounts/app-password", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ email: "me@example.com", appPassword: "abcd efgh ijkl mnop", skipVerify: true }),
    });
    await app.request("/api/outbox", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        sender: "me@example.com",
        to: ["lead@company.com"],
        subject: "Proposal",
        html: "<p>Deck</p>",
        sync: true,
      }),
    });

    // Advance 16s to trigger delayed Sent copy cleanup sweep
    await vi.advanceTimersByTimeAsync(16_000);
    expect(delayedSweepCalls).toBe(1);

    // Digest runs once for 2026-05-02 at 09:00 EDT
    const d1 = await app.notifier.sendDigest({ now: morning });
    expect(d1.sent).toBe(true);
    expect(calls.some((c) => c.payload.embeds[0].title === "Daily email digest (2026-05-02)")).toBe(true);

    // Second check on the same day is deduplicated
    const d2 = await app.notifier.sendDigest({ now: morning + 60_000 });
    expect(d2).toEqual({ sent: false, skipped: "already_sent" });

    app.outbox.stop();
    db.close();
  });

  it("cancels conditional scheduled follow-ups on live reply check, fails closed on error, sends when no reply, and cancels early in background", async () => {
    const baseTime = Date.UTC(2026, 4, 10, 12, 0, 0);
    vi.spyOn(Date, "now").mockReturnValue(baseTime);

    const db = openDb(":memory:");
    const { calls, fetchImpl } = makeFetchSpy();
    const smtpSent: string[] = [];
    let throwOnInspect = false;
    const threadReplies = new Map<string, { email: string; at: number }[]>();

    const transport: MailboxTransport = {
      ...makeFakeTransport(),
      async sendSmtpCopy(_from, to) {
        smtpSent.push(to);
      },
      async inspectThreadActivity(threadId, sentAt) {
        if (throwOnInspect) throw new Error("Gmail API temporarily unavailable");
        const hits = (threadReplies.get(threadId) ?? []).filter((r) => r.at > sentAt);
        return {
          repliedAt: hits.length > 0 ? hits[0].at : null,
          repliedBy: hits,
          bouncedAt: null,
          bounceReason: null,
        };
      },
    };

    const app = createApp(db, {
      apiKey: API_KEY,
      publicUrl: "https://t.example.com",
      discordWebhookUrl: WEBHOOK,
      fetchImpl,
      transportFactory: () => transport,
    });

    await app.request("/api/accounts/app-password", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ email: "me@example.com", appPassword: "abcd efgh ijkl mnop", skipVerify: true }),
    });

    // 1. Rejects cancelOnReply without a threadId
    const bad = await app.request("/api/outbox", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        sender: "me@example.com",
        to: ["alice@company.com"],
        subject: "New email",
        html: "<p>Hi</p>",
        sendAt: baseTime + 3_600_000,
        isScheduled: true,
        cancelOnReply: true,
      }),
    });
    expect(bad.status).toBe(400);

    // 2. Schedule follow-up on thread t_reply (which already had an OLDER reply before scheduling)
    threadReplies.set("t_reply", [{ email: "alice@company.com", at: baseTime - 60_000 }]);
    const sched1 = await (
      await app.request("/api/outbox", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          sender: "me@example.com",
          to: ["alice@company.com"],
          subject: "Re: Coffee",
          html: "<p>Bumping this</p>",
          threadId: "t_reply",
          sendAt: baseTime + 3_600_000,
          isScheduled: true,
          cancelOnReply: true,
        }),
      })
    ).json();

    const list1 = await (await app.request("/api/outbox?sender=me@example.com", { headers: auth })).json();
    expect(list1.items[0].cancelOnReply).toBe(true);

    // 3. Earlier reply before scheduling does NOT cancel it; when Gmail fails during live check, it fails closed (no SMTP send)
    vi.spyOn(Date, "now").mockReturnValue(baseTime + 3_600_000);
    throwOnInspect = true;
    await app.outbox.drainDue();
    expect(smtpSent).toHaveLength(0);
    expect(db.getOutbox(sched1.outboxId)!.status).toBe("failed");

    // 4. Re-queue and allow Gmail check: older reply before created_at is ignored, so follow-up sends normally!
    throwOnInspect = false;
    await app.outbox.reschedule(sched1.outboxId, baseTime + 3_600_000);
    await app.outbox.drainDue();
    expect(smtpSent).toEqual(["alice@company.com"]);
    expect(db.getOutbox(sched1.outboxId)!.status).toBe("sent");

    // 5. Schedule follow-up on thread t_live; a new reply arrives right before due time -> live check cancels & alerts Discord
    vi.spyOn(Date, "now").mockReturnValue(baseTime + 4_000_000);
    const sched2 = await (
      await app.request("/api/outbox", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          sender: "me@example.com",
          to: ["bob@company.com"],
          subject: "Re: Proposal",
          html: "<p>Checking in</p>",
          threadId: "t_live",
          sendAt: baseTime + 5_000_000,
          isScheduled: true,
          cancelOnReply: true,
        }),
      })
    ).json();
    threadReplies.set("t_live", [{ email: "bob@company.com", at: baseTime + 4_995_000 }]);
    vi.spyOn(Date, "now").mockReturnValue(baseTime + 5_000_000);
    await app.outbox.drainDue();
    expect(smtpSent).toEqual(["alice@company.com"]); // bob NOT sent!
    expect(db.getOutbox(sched2.outboxId)!.status).toBe("canceled");
    expect(db.getMessage(sched2.messageId)).toBeNull();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.some((c) => c.payload.embeds[0].title === "Canceled follow-up (reply received): Re: Proposal")).toBe(true);

    // 6. Early background cancellation via replyChecker even on an untracked thread
    vi.spyOn(Date, "now").mockReturnValue(baseTime + 6_000_000);
    const sched3 = await (
      await app.request("/api/outbox", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          sender: "me@example.com",
          to: ["carol@company.com"],
          subject: "Re: Untracked intro",
          html: "<p>Following up</p>",
          threadId: "t_untracked",
          sendAt: baseTime + 9_000_000,
          isScheduled: true,
          cancelOnReply: true,
        }),
      })
    ).json();
    threadReplies.set("t_untracked", [{ email: "carol@company.com", at: baseTime + 6_500_000 }]);
    vi.spyOn(Date, "now").mockReturnValue(baseTime + 6_600_000);
    await app.replyChecker.check({ sender: "me@example.com", force: true });
    expect(db.getOutbox(sched3.outboxId)!.status).toBe("canceled");
    expect(db.getMessage(sched3.messageId)).toBeNull();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.some((c) => c.payload.embeds[0].title === "Canceled follow-up (reply received): Re: Untracked intro")).toBe(true);

    // 7. Race & partial-delivery safety: claimed `sending` items and partially-delivered items are never auto-canceled
    vi.spyOn(Date, "now").mockReturnValue(baseTime + 10_000_000);
    const sched4 = await (
      await app.request("/api/outbox", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          sender: "me@example.com",
          to: ["dave@company.com", "erin@company.com"],
          subject: "Re: Group follow-up",
          html: "<p>Checking in</p>",
          threadId: "t_partial",
          sendAt: baseTime + 11_000_000,
          isScheduled: true,
          cancelOnReply: true,
        }),
      })
    ).json();
    // Simulate Dave already delivered (partial delivery) + reply arriving before retry
    const firstTok = db.listRecipientTokens(sched4.messageId)[0];
    db.markRecipientTokenSent(firstTok.token, "<sent1@example.com>", baseTime + 10_100_000);
    threadReplies.set("t_partial", [{ email: "dave@company.com", at: baseTime + 10_200_000 }]);
    expect(
      app.outbox.cancelQueuedForThreadReply({
        accountEmail: "me@example.com",
        threadId: "t_partial",
        repliedAt: baseTime + 10_200_000,
        repliedBy: ["dave@company.com"],
      }),
    ).toBe(0);
    expect(db.getOutbox(sched4.outboxId)!.status).toBe("queued");

    // Claiming an item into `sending` blocks background cancelQueuedForThreadReply
    const sched5 = await (
      await app.request("/api/outbox", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          sender: "me@example.com",
          to: ["frank@company.com"],
          subject: "Re: Claimed",
          html: "<p>Hi</p>",
          threadId: "t_race",
          sendAt: baseTime + 12_000_000,
          isScheduled: true,
          cancelOnReply: true,
        }),
      })
    ).json();
    db.claimOutboxById(sched5.outboxId, baseTime + 12_000_000);
    expect(
      app.outbox.cancelQueuedForThreadReply({
        accountEmail: "me@example.com",
        threadId: "t_race",
        repliedAt: baseTime + 12_000_500,
        repliedBy: ["frank@company.com"],
      }),
    ).toBe(0);
    expect(db.getOutbox(sched5.outboxId)!.status).toBe("sending");

    db.close();
  });
});
