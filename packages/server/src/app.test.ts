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

  it("serves the gif for unknown ids without recording", async () => {
    const app = setup();
    const res = await app.request("/p/nope.gif");
    expect(res.status).toBe(200);
    const list = await app.request("/api/messages", { headers: auth });
    expect(await list.json()).toEqual([]);
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
