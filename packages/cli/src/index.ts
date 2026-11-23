#!/usr/bin/env node
import { parseArgs } from "node:util";
import { configPath, readConfig, writeConfig, type Config } from "./config.js";
import { authorize } from "./gmail.js";
import { attachmentPaths, readRows } from "./input.js";
import { textToHtml } from "./mime.js";
import { status } from "./status.js";
import { connectAppPasswordAccount, connectOAuthAccount, listConnectedAccounts, sendViaOutbox } from "./tracker.js";

const usage = `openmt <command>

  auth   Configure the CLI and optionally connect a Gmail / Workspace account on the server
         --server <url> --api-key <key> --sender-name <name> --sender-email <email>
         [--client-id <id> --client-secret <secret>] [--app-password <16-char-password>]
  send   Send tracked mail from a CSV or XLSX via your server's unified SMTP pipeline
         (pixel-free Sent copy + per-recipient tracking even with --cc).
         Every file in ./files is attached to every email.
         --input <file> [--from <email>] [--sender-name <name>] [--limit <n>] [--delay <seconds>] [--cc <email>] [--dry-run]
  status Tracked messages, most recently opened first
         [--since 7d] [--opened | --unopened] [--sender | --from you@gmail.com] [--json]
`;

async function auth(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      server: { type: "string" },
      "api-key": { type: "string" },
      "client-id": { type: "string" },
      "client-secret": { type: "string" },
      "app-password": { type: "string" },
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
  };
  for (const [k, v] of [
    ["--server", config.serverUrl],
    ["--api-key", config.apiKey],
    ["--sender-name", config.senderName],
    ["--sender-email", config.senderEmail],
  ]) {
    if (!v) throw new Error(`${k} is required`);
  }

  if (values["app-password"]) {
    await connectAppPasswordAccount(config, {
      email: config.senderEmail,
      appPassword: values["app-password"],
      displayName: config.senderName,
    });
    console.log(`Connected ${config.senderEmail} on server via App Password.`);
  } else if (values["client-id"] && values["client-secret"]) {
    const refreshToken = await authorize({
      clientId: values["client-id"],
      clientSecret: values["client-secret"],
    });
    await connectOAuthAccount(config, {
      email: config.senderEmail,
      clientId: values["client-id"],
      clientSecret: values["client-secret"],
      refreshToken,
      displayName: config.senderName,
    });
    console.log(`Connected ${config.senderEmail} on server via Google OAuth.`);
  }

  writeConfig(config);
  console.log(`Saved ${configPath}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function send(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      input: { type: "string", default: "contacts.csv" },
      from: { type: "string" },
      "sender-name": { type: "string" },
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

  const senderEmail = (values.from ?? config.senderEmail).trim().toLowerCase();
  let senderName = values["sender-name"] ?? config.senderName;
  if (!dryRun) {
    const connected = await listConnectedAccounts(config);
    const match = connected.find((a) => a.email.toLowerCase() === senderEmail);
    if (!match) {
      const available = connected.map((a) => a.email).join(", ") || "(none)";
      throw new Error(`Account ${senderEmail} is not connected on server. Connected accounts: ${available}`);
    }
    if (!values["sender-name"] && match.displayName) senderName = match.displayName;
  }
  const from = senderName ? `${senderName} <${senderEmail}>` : senderEmail;

  console.log(`Sending ${batch.length} emails from ${from} via open-mailtrack server (${dryRun ? "DRY RUN" : "LIVE"})`);
  if (attachments.length) console.log(`Attaching ${attachments.join(", ")}`);
  console.log();
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
      const result = await sendViaOutbox(config, {
        sender: senderEmail,
        from,
        to: [to],
        cc: values.cc ? [values.cc] : [],
        subject,
        html: `<div>${textToHtml(body)}</div>`,
        text: body,
        attachmentPaths: attachments,
      });
      if (result.status !== "sent") {
        throw new Error(`Unexpected server outbox status: ${result.status}`);
      }
      console.log(`${label} sent (${result.messageId})`);
      sent++;
    } catch (err) {
      console.log(`${label} failed: ${(err as Error).message}`);
      failed++;
      if (/HTTP 40[13]|HTTP 412/.test((err as Error).message)) break;
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
