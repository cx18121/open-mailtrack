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

  it("records self views by thread and returns them with the message", async () => {
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
    const sv = await app.request("/api/self-views", { method: "POST", headers: auth, body: JSON.stringify({ gmailThreadId: "gt1" }) });
    expect(sv.status).toBe(204);
    const detail = await (await app.request(`/api/messages/${id}`, { headers: auth })).json();
    expect(detail.selfViews).toHaveLength(1);
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

  it("rejects api calls without the key", async () => {
    const app = setup();
    expect((await app.request("/api/messages")).status).toBe(401);
  });
});
