import { dirname, join } from "node:path";
import { serve } from "@hono/node-server";
import { createAppleRelayStore } from "./apple-mpp.js";
import { createApp } from "./app.js";
import { openDb } from "./db.js";
import { parseIpListEnv } from "./settings.js";

const apiKey = process.env.API_KEY;
if (!apiKey) throw new Error("API_KEY is required");

const publicUrl = (process.env.PUBLIC_URL ?? "http://localhost:8787").replace(/\/$/, "");
const port = Number(process.env.PORT ?? 8787);
const dbPath = process.env.DB_PATH ?? "./open-mailtrack.db";
const db = openDb(dbPath);
const appleRelay = createAppleRelayStore({
  cachePath: join(dirname(dbPath), "apple-relay-ips.csv"),
});
appleRelay.startBackgroundRefresh();

const digestHourRaw = process.env.DISCORD_DIGEST_HOUR?.trim();
const digestHour = digestHourRaw !== undefined && digestHourRaw !== "" ? Number(digestHourRaw) : undefined;

const app = createApp(db, {
  apiKey,
  publicUrl,
  encryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
  ignoredIps: parseIpListEnv(process.env.IGNORED_IPS),
  digestHour: Number.isInteger(digestHour) ? digestHour : undefined,
  digestTimezone: process.env.DISCORD_DIGEST_TIMEZONE?.trim() || undefined,
  appleRelay,
});
app.outbox.start();
app.replyChecker.start();
app.notifier.start();

const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`open-mailtrack server on :${port}, pixel base ${publicUrl}/p/`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    appleRelay.stop();
    app.replyChecker.stop();
    app.notifier.stop();
    void app.outbox.stopAndDrain().finally(() => {
      server.close(() => {
        db.close();
        process.exit(0);
      });
    });
  });
}
