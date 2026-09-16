#!/usr/bin/env node
import { parseArgs } from "node:util";
import { configPath, readConfig, writeConfig, type Config } from "./config.js";
import { accessToken, authorize, sendRaw } from "./gmail.js";
import { attachmentPaths, readRows } from "./input.js";
import { buildRaw } from "./mime.js";
import { status } from "./status.js";
import { createTracked, markSent } from "./tracker.js";

const usage = `openmt <command>

  auth   Configure the server and Google credentials, then sign in to Gmail
         --server <url> --api-key <key> --client-id <id> --client-secret <secret>
         --sender-name <name> --sender-email <email>
  send   Send tracked mail from a CSV or XLSX with columns contact_email, subject, body.
         Every file in ./files is attached to every email.
         --input <file> [--limit <n>] [--delay <seconds>] [--cc <email>] [--dry-run]
  status Tracked messages, most recently opened first
         [--since 7d] [--opened | --unopened] [--json]
`;

async function auth(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      server: { type: "string" },
      "api-key": { type: "string" },
      "client-id": { type: "string" },
      "client-secret": { type: "string" },
      "sender-name": { type: "string" },
      "sender-email": { type: "string" },
    },
  });
  let existing: Config | null = null;
  try {
    existing = readConfig();
  } catch {}
  const config: Config = {
    serverUrl: (values.server ?? existing?.serverUrl ?? "").replace(/\/$/, ""),
    apiKey: values["api-key"] ?? existing?.apiKey ?? "",
    senderName: values["sender-name"] ?? existing?.senderName ?? "",
    senderEmail: values["sender-email"] ?? existing?.senderEmail ?? "",
    google: {
      clientId: values["client-id"] ?? existing?.google.clientId ?? "",
      clientSecret: values["client-secret"] ?? existing?.google.clientSecret ?? "",
    },
  };
  for (const [k, v] of [
    ["--server", config.serverUrl],
    ["--api-key", config.apiKey],
    ["--client-id", config.google.clientId],
    ["--client-secret", config.google.clientSecret],
    ["--sender-name", config.senderName],
    ["--sender-email", config.senderEmail],
  ]) {
    if (!v) throw new Error(`${k} is required`);
  }
  config.google.refreshToken = await authorize(config.google);
  writeConfig(config);
  console.log(`Saved ${configPath}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function send(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      input: { type: "string", default: "contacts.csv" },
      limit: { type: "string", default: "9999" },
      delay: { type: "string", default: "30" },
      cc: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const config = readConfig();
  const rows = await readRows(values.input);
  const batch = rows.slice(0, Number(values.limit));
  const attachments = attachmentPaths();
  const dryRun = values["dry-run"];
  const delayMs = Number(values.delay) * 1000;
  const from = `${config.senderName} <${config.senderEmail}>`;

  console.log(`Sending ${batch.length} emails via Gmail (${dryRun ? "DRY RUN" : "LIVE"})`);
  if (attachments.length) console.log(`Attaching ${attachments.join(", ")}`);
  console.log();
  const token = dryRun ? "" : await accessToken(config.google);
  let sent = 0;
  let failed = 0;

  for (const [i, row] of batch.entries()) {
    const to = row.contact_email || row.email;
    const { subject, body } = row;
    const label = `[${i + 1}/${batch.length}] ${to}`;
    if (!to || !subject || !body) {
      console.log(`${label} skipped, missing field`);
      failed++;
      continue;
    }
    if (dryRun) {
      console.log(`${label} ${subject}`);
      continue;
    }
    try {
      const tracked = await createTracked(config, {
        sender: config.senderEmail,
        recipients: [to, ...(values.cc ? [values.cc] : [])],
        subject,
      });
      const result = await sendRaw(token, buildRaw({ from, to, cc: values.cc, subject, text: body, pixelUrl: tracked.pixelUrl, attachments }));
      await markSent(config, tracked.id, result);
      console.log(`${label} sent (${tracked.id})`);
      sent++;
    } catch (err) {
      console.log(`${label} failed: ${(err as Error).message}`);
      failed++;
      if (/HTTP 40[13]/.test((err as Error).message)) break;
    }
    if (i < batch.length - 1) await sleep(delayMs);
  }
  console.log(`\nDone. Sent: ${sent}  Failed: ${failed}`);
}

const [command, ...rest] = process.argv.slice(2);
const commands: Record<string, (argv: string[]) => Promise<void>> = { auth, send, status };
const run = commands[command ?? ""];
if (!run) {
  console.log(usage);
  process.exit(command ? 1 : 0);
}
run(rest).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
