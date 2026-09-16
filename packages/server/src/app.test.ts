import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { openDb } from "./db.js";

const config = { apiKey: "k", publicUrl: "https://t.example.com" };
const auth = { authorization: "Bearer k", "content-type": "application/json" };

function setup() {
  const db = openDb(":memory:");
  return createApp(db, config);
}

describe("pixel", () => {
  it("registers a message and records a hit with request evidence", async () => {
    const app = setup();
    const created = await app.request("/api/messages", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ sender: "me@x.com", recipients: ["a@y.com"], subject: "hi", source: "cli" }),
    });
    expect(created.status).toBe(201);
    const { id, pixelUrl } = await created.json();
    expect(pixelUrl).toBe(`https://t.example.com/p/${id}.gif`);

    const pixel = await app.request(`/p/${id}.gif`, {
      headers: { "user-agent": "GoogleImageProxy", "cf-connecting-ip": "66.102.1.1" },
    });
    expect(pixel.status).toBe(200);
    expect(pixel.headers.get("content-type")).toBe("image/gif");
    expect(pixel.headers.get("cache-control")).toContain("no-store");

    const detail = await app.request(`/api/messages/${id}`, { headers: auth });
    const body = await detail.json();
    expect(body.hits).toHaveLength(1);
    expect(body.hits[0]).toMatchObject({ ip: "66.102.1.1", user_agent: "GoogleImageProxy" });
    expect(body.hits[0].headers["cf-connecting-ip"]).toBe("66.102.1.1");
  });

  it("records hits for a client-chosen id before registration and joins them later", async () => {
    const app = setup();
    const id = "AAAAAAAAAAAAAAAAAAAAAA";
    expect((await app.request(`/p/${id}.gif`)).status).toBe(200);
    const created = await app.request("/api/messages", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id, sender: "me@x.com", recipients: ["a@y.com"], subject: "hi" }),
    });
    expect(created.status).toBe(201);
    expect((await created.json()).id).toBe(id);
    const detail = await (await app.request(`/api/messages/${id}`, { headers: auth })).json();
    expect(detail.hits).toHaveLength(1);
  });

  it("serves the gif for malformed ids without recording", async () => {
    const app = setup();
    expect((await app.request("/p/nope.gif")).status).toBe(200);
    expect((await app.request("/p/short.gif")).status).toBe(200);
  });

  it("classifies the sender's own view and reports status by gmail message and thread id", async () => {
    const app = setup();
    const { id } = await (
      await app.request("/api/messages", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ sender: "me@x.com", recipients: ["a@y.com"], subject: "hi" }),
      })
    ).json();
    await app.request(`/api/messages/${id}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ gmailMessageId: "gm1", gmailThreadId: "gt1" }),
    });
    await app.request(`/p/${id}.gif`, { headers: { "user-agent": "GoogleImageProxy" } });
    const view = await app.request("/api/views", { method: "POST", headers: auth, body: JSON.stringify({ gmailMessageId: "gm1" }) });
    expect(view.status).toBe(204);
    const detail = await (await app.request(`/api/messages/${id}`, { headers: auth })).json();
    expect(detail.views).toHaveLength(1);
    expect(detail.hits[0].kind).toBe("self_view");
    expect(detail.opens).toBe(0);

    const status = await (await app.request("/api/status?messageIds=gm1,unknown&threadIds=gt1", { headers: auth })).json();
    expect(status.messages).toEqual({ gm1: { opens: 0, firstOpenAt: null, lastOpenAt: null, openAts: [], late: null } });
    expect(status.threads.gt1).toMatchObject({ tracked: 1, opens: 0 });
  });

  it("answers cors preflight for the api", async () => {
    const app = setup();
    const res = await app.request("/api/messages", {
      method: "OPTIONS",
      headers: { origin: "https://mail.google.com", "access-control-request-method": "POST" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("attaches gmail ids after send", async () => {
    const app = setup();
    const { id } = await (
      await app.request("/api/messages", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ sender: "me@x.com", recipients: ["a@y.com"], subject: "hi" }),
      })
    ).json();
    const patched = await app.request(`/api/messages/${id}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ gmailMessageId: "gm1", gmailThreadId: "gt1" }),
    });
    expect(patched.status).toBe(204);
    const detail = await (await app.request(`/api/messages/${id}`, { headers: auth })).json();
    expect(detail).toMatchObject({ gmail_message_id: "gm1", gmail_thread_id: "gt1" });
    expect(detail.sent_at).toBeTypeOf("number");
  });

  it("lists messages most recently opened first, then unopened by send time", async () => {
    const app = setup();
    const create = async (subject: string) =>
      (await (await app.request("/api/messages", { method: "POST", headers: auth, body: JSON.stringify({ sender: "me@x.com", recipients: ["a@y.com"], subject }) })).json()).id;
    const a = await create("a");
    const b = await create("b");
    const c = await create("c");
    await app.request(`/p/${a}.gif`);
    await new Promise((r) => setTimeout(r, 5));
    await app.request(`/p/${c}.gif`);
    const list = await (await app.request("/api/messages", { headers: auth })).json();
    expect(list.total).toBe(3);
    expect(list.messages.map((m: { subject: string }) => m.subject)).toEqual(["c", "a", "b"]);
    const page = await (await app.request("/api/messages?offset=1&limit=1", { headers: auth })).json();
    expect(page.messages.map((m: { subject: string }) => m.subject)).toEqual(["a"]);
  });

  it("marks messages sent before a reply as replied, keeping the earliest reply", async () => {
    const app = setup();
    const { id } = await (
      await app.request("/api/messages", { method: "POST", headers: auth, body: JSON.stringify({ sender: "me@x.com", recipients: ["a@y.com"], subject: "hi" }) })
    ).json();
    await app.request(`/api/messages/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ gmailMessageId: "gm1", gmailThreadId: "gt1" }) });
    const sentAt = (await (await app.request(`/api/messages/${id}`, { headers: auth })).json()).sent_at;

    const before = await (await app.request("/api/replies", { method: "POST", headers: auth, body: JSON.stringify({ gmailThreadId: "gt1", repliedAt: sentAt - 1000 }) })).json();
    expect(before.updated).toBe(0);
    const later = await (await app.request("/api/replies", { method: "POST", headers: auth, body: JSON.stringify({ gmailThreadId: "gt1", repliedAt: sentAt + 5000 }) })).json();
    expect(later.updated).toBe(1);
    await app.request("/api/replies", { method: "POST", headers: auth, body: JSON.stringify({ gmailThreadId: "gt1", repliedAt: sentAt + 2000 }) });
    const detail = await (await app.request(`/api/messages/${id}`, { headers: auth })).json();
    expect(detail.replied_at).toBe(sentAt + 2000);
  });

  it("rejects api calls without the key", async () => {
    const app = setup();
    expect((await app.request("/api/messages")).status).toBe(401);
  });
});
