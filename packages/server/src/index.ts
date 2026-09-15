import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { openDb } from "./db.js";

const apiKey = process.env.API_KEY;
if (!apiKey) throw new Error("API_KEY is required");

const publicUrl = (process.env.PUBLIC_URL ?? "http://localhost:8787").replace(/\/$/, "");
const port = Number(process.env.PORT ?? 8787);
const db = openDb(process.env.DB_PATH ?? "./open-mailtrack.db");

serve({ fetch: createApp(db, { apiKey, publicUrl }).fetch, port }, () => {
  console.log(`open-mailtrack server on :${port}, pixel base ${publicUrl}/p/`);
});
