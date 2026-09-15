import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import type { Config } from "./config.js";

const SCOPE = "https://www.googleapis.com/auth/gmail.send";
const REDIRECT_PORT = 8765;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

export async function authorize(google: Config["google"]): Promise<string> {
  const state = randomBytes(8).toString("hex");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: google.clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  }).toString();

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const q = new URL(req.url ?? "/", REDIRECT_URI).searchParams;
      if (q.get("state") !== state || !q.get("code")) {
        res.writeHead(400).end("Bad callback");
        return;
      }
      res.end("Authorized. You can close this tab.");
      server.close();
      resolve(q.get("code")!);
    });
    server.on("error", reject);
    server.listen(REDIRECT_PORT, () => {
      console.log(`Opening browser for Google sign-in. If it does not open, visit:\n${url}`);
      execFile(process.platform === "darwin" ? "open" : "xdg-open", [url.toString()], () => {});
    });
  });

  const token = await postToken({
    code,
    client_id: google.clientId,
    client_secret: google.clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  });
  if (!token.refresh_token) throw new Error("Google did not return a refresh token");
  return token.refresh_token;
}

export async function accessToken(google: Config["google"]): Promise<string> {
  if (!google.refreshToken) throw new Error("Not authorized. Run `openmt auth`.");
  const token = await postToken({
    client_id: google.clientId,
    client_secret: google.clientSecret,
    refresh_token: google.refreshToken,
    grant_type: "refresh_token",
  });
  return token.access_token;
}

async function postToken(params: Record<string, string>) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const body = (await res.json()) as { access_token: string; refresh_token?: string; error?: string; error_description?: string };
  if (!res.ok) throw new Error(`Google token error: ${body.error} ${body.error_description ?? ""}`.trim());
  return body;
}

export type SendResult = { id: string; threadId: string };

export async function sendRaw(token: string, raw: string): Promise<SendResult> {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) throw new Error(`Gmail send failed: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as SendResult;
}
