import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { classifyHit, summarize, CLASSIFIER_VERSION, type OpenSummary } from "./classify.js";
import type { Db, Message } from "./db.js";

const ID = /^[A-Za-z0-9_-]{22}$/;
export const newId = () => randomBytes(16).toString("base64url");

const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

export type Config = { apiKey: string; publicUrl: string };

export function createApp(db: Db, config: Config) {
  const app = new Hono();

  const classified = (m: Message) => {
    const views = m.gmail_message_id ? db.listViews(m.gmail_message_id) : [];
    return db.listHits(m.id).map((h) => classifyHit(h, views, m.sent_at));
  };
  const summaryOf = (m: Message) => summarize(classified(m), m.sent_at);

  app.get("/p/:file", (c) => {
    const id = c.req.param("file").replace(/\.gif$/, "");
    if (ID.test(id)) {
      const headers: Record<string, string> = {};
      c.req.raw.headers.forEach((v, k) => (headers[k] = v));
      db.recordHit({
        message_id: id,
        ip: headers["cf-connecting-ip"] ?? headers["x-forwarded-for"]?.split(",")[0].trim() ?? null,
        user_agent: headers["user-agent"] ?? null,
        headers,
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

  const api = new Hono();
  api.use(cors({ origin: "*", allowHeaders: ["authorization", "content-type"], allowMethods: ["GET", "POST", "PATCH"] }));
  api.use(async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${config.apiKey}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

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
    db.createMessage({ id, sender: body.sender, recipients: body.recipients, subject: body.subject, source: body.source ?? "extension" });
    const pixelUrl = `${config.publicUrl}/p/${id}.gif`;
    return c.json({ id, pixelUrl }, 201);
  });

  api.patch("/messages/:id", async (c) => {
    const body = await c.req.json<{ gmailMessageId: string; gmailThreadId: string }>();
    if (!body.gmailMessageId || !body.gmailThreadId) {
      return c.json({ error: "gmailMessageId, gmailThreadId required" }, 400);
    }
    const ok = db.markSent(c.req.param("id"), {
      messageId: body.gmailMessageId,
      threadId: body.gmailThreadId,
    });
    return ok ? c.body(null, 204) : c.json({ error: "not found" }, 404);
  });

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
    const messages: Record<string, ReturnType<typeof summarize>> = {};
    for (const m of db.findByGmailMessageIds(messageIds)) messages[m.gmail_message_id!] = summaryOf(m);
    const threads: Record<string, { tracked: number; opens: number; lastOpenAt: number | null; late: OpenSummary["late"] }> = {};
    for (const m of db.findByGmailThreadIds(threadIds)) {
      const s = summaryOf(m);
      const t = (threads[m.gmail_thread_id!] ??= { tracked: 0, opens: 0, lastOpenAt: null, late: null });
      t.tracked++;
      t.opens += s.opens;
      if (s.lastOpenAt && (!t.lastOpenAt || s.lastOpenAt > t.lastOpenAt)) {
        t.lastOpenAt = s.lastOpenAt;
        t.late = s.late;
      }
    }
    return c.json({ messages, threads, classifierVersion: CLASSIFIER_VERSION });
  });

  /**
   * Tracked messages with their open summary, most recently opened first, then unopened by send time.
   * `since` limits to messages sent or opened after that time. `offset`/`limit` page the result.
   */
  api.get("/messages", (c) => {
    const since = Number(c.req.query("since") ?? 0);
    const offset = Number(c.req.query("offset") ?? 0);
    const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
    const all = db
      .listMessages()
      .map((m) => ({ ...m, ...summaryOf(m), hits: db.listHits(m.id).length }))
      .filter((m) => (m.sent_at ?? m.created_at) >= since || (m.lastOpenAt ?? 0) >= since)
      .sort((a, b) => (b.lastOpenAt ?? 0) - (a.lastOpenAt ?? 0) || (b.sent_at ?? b.created_at) - (a.sent_at ?? a.created_at));
    return c.json({ total: all.length, messages: all.slice(offset, offset + limit) });
  });

  api.get("/messages/:id", (c) => {
    const message = db.getMessage(c.req.param("id"));
    if (!message) return c.json({ error: "not found" }, 404);
    const hits = classified(message);
    return c.json({
      ...message,
      ...summarize(hits, message.sent_at),
      hits: db.listHits(message.id).map((h, i) => ({ ...h, kind: hits[i].kind, reason: hits[i].reason })),
      views: message.gmail_message_id ? db.listViews(message.gmail_message_id) : [],
    });
  });

  app.route("/api", api);
  return app;
}
