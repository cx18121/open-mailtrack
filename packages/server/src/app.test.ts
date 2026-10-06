import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { openDb } from "./db.js";

const config = { apiKey: "k", publicUrl: "https://t.example.com" };
const auth = { authorization: "Bearer k", "content-type": "application/json" };

function setup() {
  const db = openDb(":memory:");
  return createApp(db, config);
}

afterEach(() => vi.restoreAllMocks());

const PREFETCH = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/42.0.2311.135 Safari/537.36 Edge/12.246 Mozilla/5.0";

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

  it.each([
    { sentAt: 1791304670944, delta: 376, ua: "GoogleImageProxy" },
    { sentAt: 1790620079541, delta: 12_266, ua: PREFETCH },
  ])("excludes a recorded automated fetch with no sender view ($delta ms)", async ({ sentAt, delta, ua }) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(sentAt - 500);
    const app = setup();
    const { id } = await (await app.request("/api/messages", {
      method: "POST", headers: auth,
      body: JSON.stringify({ sender: "me@x.com", recipients: ["a@y.com"], subject: "hi", source: "extension" }),
    })).json();
    now.mockReturnValue(sentAt);
    expect((await app.request(`/api/messages/${id}`, {
      method: "PATCH", headers: auth,
      body: JSON.stringify({ gmailMessageId: "gm1", gmailThreadId: "gt1" }),
    })).status).toBe(204);
    now.mockReturnValue(sentAt + delta);
    expect((await app.request(`/p/${id}.gif`, { headers: { "user-agent": ua } })).status).toBe(200);

    const detail = async () => (await app.request(`/api/messages/${id}`, { headers: auth })).json();
    const list = async () => (await app.request("/api/messages", { headers: auth })).json();
    const status = async () => (await app.request("/api/status?messageIds=gm1&threadIds=gt1", { headers: auth })).json();
    const excluded = await detail();
    expect(excluded.views).toEqual([]);
    expect(excluded.hits).toHaveLength(1);
    expect(excluded.hits[0]).toMatchObject({ at: sentAt + delta, user_agent: ua, kind: "prefetch" });
    expect(excluded).toMatchObject({ opens: 0, firstOpenAt: null, lastOpenAt: null, openAts: [] });
    expect((await list()).messages[0]).toMatchObject({ opens: 0, hits: 1 });
    const unopened = await status();
    expect(unopened.messages.gm1.opens).toBe(0);
    expect(unopened.threads.gt1).toMatchObject({ tracked: 1, opens: 0, lastOpenAt: null });

    // A later fetch still produces an opened status without deleting the excluded evidence.
    const openAt = sentAt + 127_896;
    now.mockReturnValue(openAt);
    await app.request(`/p/${id}.gif`, { headers: { "user-agent": "GoogleImageProxy" } });
    expect(await detail()).toMatchObject({ opens: 1, firstOpenAt: openAt, lastOpenAt: openAt, openAts: [openAt] });
    expect((await list()).messages[0]).toMatchObject({ opens: 1, hits: 2 });
    const opened = await status();
    expect(opened.classifierVersion).toBe(5);
    expect(opened.messages.gm1.opens).toBe(1);
    expect(opened.threads.gt1).toMatchObject({ tracked: 1, opens: 1, lastOpenAt: openAt });
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
    const mine = await (await app.request("/api/messages?sender=ME@x.com", { headers: auth })).json();
    expect(mine.total).toBe(3);
    const none = await (await app.request("/api/messages?sender=other@x.com", { headers: auth })).json();
    expect(none.total).toBe(0);
  });

  it("rejects api calls without the key", async () => {
    const app = setup();
    expect((await app.request("/api/messages")).status).toBe(401);
  });
});
