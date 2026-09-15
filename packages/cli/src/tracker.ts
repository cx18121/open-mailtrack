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
