import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import type { Db } from "./db.js";

const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

export type Config = { apiKey: string; publicUrl: string };

export function createApp(db: Db, config: Config) {
  const app = new Hono();

  app.get("/p/:file", (c) => {
    const id = c.req.param("file").replace(/\.gif$/, "");
    if (db.getMessage(id)) {
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
  api.use(async (c, next) => {
    if (c.req.header("authorization") !== `Bearer ${config.apiKey}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  api.post("/messages", async (c) => {
    const body = await c.req.json<{
      sender: string;
      recipients: string[];
      subject: string;
      source: "extension" | "cli";
    }>();
    if (!body.sender || !Array.isArray(body.recipients) || typeof body.subject !== "string") {
      return c.json({ error: "sender, recipients, subject required" }, 400);
    }
    const id = randomBytes(16).toString("base64url");
    db.createMessage({ id, ...body, source: body.source ?? "extension" });
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

  api.get("/messages", (c) => {
    const messages = db.listMessages().map((m) => ({ ...m, hits: db.listHits(m.id).length }));
    return c.json(messages);
  });

  api.get("/messages/:id", (c) => {
    const message = db.getMessage(c.req.param("id"));
    if (!message) return c.json({ error: "not found" }, 404);
    return c.json({ ...message, hits: db.listHits(message.id) });
  });

  app.route("/api", api);
  return app;
}
