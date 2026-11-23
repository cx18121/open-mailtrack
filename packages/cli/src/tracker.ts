import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Config } from "./config.js";
import type { SendResult } from "./gmail.js";

async function api(config: Config, path: string, init: RequestInit) {
  const res = await fetch(`${config.serverUrl}/api${path}`, {
    ...init,
    headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json", ...init.headers },
  });
  if (!res.ok) throw new Error(`Tracker ${path} failed: HTTP ${res.status} ${await res.text()}`);
  return res;
}

export async function createTracked(
  config: Config,
  message: { sender: string; recipients: string[]; subject: string },
): Promise<{ id: string; pixelUrl: string }> {
  const res = await api(config, "/messages", { method: "POST", body: JSON.stringify({ ...message, source: "cli" }) });
  return res.json();
}

export async function markSent(config: Config, id: string, result: SendResult) {
  await api(config, `/messages/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ gmailMessageId: result.id, gmailThreadId: result.threadId }),
  });
}

export type OutboxSendInput = {
  sender: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  html: string;
  text: string;
  attachmentPaths?: string[];
};

export async function sendViaOutbox(
  config: Config,
  input: OutboxSendInput,
): Promise<{ outboxId: string; messageId: string; status: string; gmailMessageId?: string; gmailThreadId?: string }> {
  const attachments = (input.attachmentPaths ?? []).map((p) => ({
    filename: basename(p),
    contentType: "application/octet-stream",
    contentBase64: readFileSync(p).toString("base64"),
  }));
  const res = await api(config, "/outbox", {
    method: "POST",
    body: JSON.stringify({
      sender: input.sender,
      from: input.from,
      to: input.to,
      cc: input.cc ?? [],
      bcc: [],
      subject: input.subject,
      html: input.html,
      text: input.text,
      attachments,
      source: "cli",
      sync: true,
    }),
  });
  return res.json();
}

export async function connectOAuthAccount(
  config: Config,
  body: { email: string; clientId: string; clientSecret: string; refreshToken: string; displayName?: string },
) {
  const res = await api(config, "/accounts/oauth/import", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function connectAppPasswordAccount(
  config: Config,
  body: { email: string; appPassword: string; displayName?: string },
) {
  const res = await api(config, "/accounts/app-password", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return res.json();
}
