import { dirname, join } from "node:path";
import { serve } from "@hono/node-server";
import { createAppleRelayStore } from "./apple-mpp.js";
import { createApp } from "./app.js";
import { openDb } from "./db.js";

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

const app = createApp(db, {
  apiKey,
  publicUrl,
  encryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  appleRelay,
});
app.outbox.start();
app.replyChecker.start();

const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`open-mailtrack server on :${port}, pixel base ${publicUrl}/p/`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    appleRelay.stop();
    app.replyChecker.stop();
    void app.outbox.stopAndDrain().finally(() => {
      server.close(() => {
        db.close();
        process.exit(0);
      });
    });
  });
}
