import type { Settings } from "./settings.js";

export type Registration = {
  id: string;
  sender: string;
  recipients: string[];
  subject: string;
};

export function createApi(settings: Settings) {
  async function call(path: string, method: string, body: unknown) {
    const res = await fetch(`${settings.serverUrl}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${settings.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`open-mailtrack ${method} ${path}: HTTP ${res.status}`);
  }
  return {
    register: (r: Registration) => call("/messages", "POST", { ...r, source: "extension" }),
    markSent: (id: string, gmailMessageId: string, gmailThreadId: string) =>
      call(`/messages/${id}`, "PATCH", { gmailMessageId, gmailThreadId }),
    selfView: (gmailThreadId: string) => call("/self-views", "POST", { gmailThreadId }),
  };
}
