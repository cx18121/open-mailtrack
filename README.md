# open-mailtrack

Self-hosted open tracking for Gmail and Google Workspace cause I didn't want to pay for mailsuite

- **Server**: records tracking pixel hits, dispatches per-recipient SMTP copies, keeps your Sent folder pixel-free, runs server-backed Undo Send and Schedule Send, and tracks per-contact history. Uses Node, SQLite, and a Docker container
- **Chrome extension**: routes tracked Gmail sends and scheduled sends through your server, shows per-recipient open status in your sent list and on each message, and adds a `Tracked` view with Messages, Scheduled, and Contacts tabs
- **CLI** (`openmt`): sends tracked mail from a CSV or XLSX through the server's unified SMTP pipeline (pixel-free Sent copies and per-recipient `--cc` tracking)

## how it works

Connected Gmail and Google Workspace accounts send tracked mail through your self-hosted server via Gmail SMTP (`smtp.gmail.com`):
- **Per-recipient tracking.** Every recipient in `To`, `Cc`, and `Bcc` receives their own SMTP copy (`RCPT TO`) with a unique 1×1 tracking pixel while preserving identical `To`, `Cc`, `Subject`, `In-Reply-To`, and `References` headers so group threads and Reply-All work normally. `Bcc` headers are stripped from all recipient copies. Gmail compose caps per-recipient group tracking at 25 recipients per email.
- **All-device self-open immunity.** After SMTP delivery, the server deletes the duplicate Sent copies Gmail auto-saves and inserts one clean, pixel-free copy into `SENT` (retaining `Bcc` for your own records). Viewing your sent mail on your phone, tablet, or another browser will not trigger a false open. The extension also keeps its browser-profile pixel-blocking rule enabled to block quoted pixels in incoming replies.
- **Unified outbox (Undo Send, Schedule Send, and conditional follow-ups).** Clicking Send queues the email in SQLite for your configured Undo Send delay (default 5 seconds) and removes the Gmail draft. Clicking Undo cancels dispatch and restores the draft in Gmail. Gmail's Schedule Send menu queues messages in the same outbox, manageable in `Tracked → Scheduled` (Send now, Reschedule, or Cancel and restore draft). When scheduling a reply in an existing thread, you can enable **Cancel automatically if they reply** so the server cancels the follow-up (with a Discord notice) if someone replies before send time.
- **Fail closed and unconnected accounts.** If your server or SMTP fails, the compose window and draft stay open with an error banner. Gmail accounts not yet connected to the server send natively and untracked with a prompt to connect.
- **Apple Mail Privacy Protection (MPP).** The server downloads and caches Apple's published iCloud Private Relay egress IP CSV (`https://mask-api.icloud.com/egress-ip-ranges.csv`). Hits from Apple relay IPs with bare `Mozilla/5.0` are classified as `apple_mpp` and shown with a distinct muted blue-grey icon ("Apple Mail privacy proxy · may have been opened") without turning checkmarks green or inflating confirmed open counts.
- **Gmail prefetch, bot, IP, and post-reply filtering.** Gmail's prefetch bot, Google/Yahoo immediate post-send fetches, known security/preview scanners, and configured ignored IPs/CIDRs are excluded. Once a recipient replies, subsequent `GoogleImageProxy` hits on their token are suppressed as `post_reply` so viewing replies in the mobile Gmail app does not inflate open counts.
- **Client hints and bounce detection.** Opens display honest client/device hints (`Gmail`, `iPhone`, `Outlook`, etc.). Thread checks distinguish `mailer-daemon` / DSN bounces from human replies, badge bounced emails, and exclude them from `Not opened` and `Needs follow-up`.
- **Discord webhook alerts and daily digest.** Configure a Discord webhook in extension options (or `.env`) for desktop and mobile alerts on first confirmed open, hot spikes (3/5/10 opens), revivals (reopened after 2+ days), bounces, and an optional daily summary digest.
- **Per-contact history and inline thread sidebar.** Browse all contacts in `Tracked → Contacts`, click any recipient in a thread's status line, or open the **Open history** panel in Gmail's right sidebar while reading a thread. Legacy multi-recipient messages sent before this upgrade appear as "Opened (group, recipient unknown)" without skewing individual open rates.
- **Follow-up and no-reply radar.** The server periodically checks Gmail threads for replies and bounces. In `Tracked → Messages`, the **Needs follow-up** filter surfaces emails sent 1 to 30 days ago with no reply yet (opened leads first), with **Check replies** and **Dismiss** controls.

## server

You need a public HTTPS hostname. The compose file uses a Cloudflare Tunnel so nothing inbound is opened.

```bash
git clone https://github.com/cx18121/open-mailtrack.git
cd open-mailtrack/deploy
cp .env.example .env   # API_KEY, PUBLIC_URL (https://t.example.com), TUNNEL_TOKEN
docker compose up -d --build
```

Optional `.env` variables:
- `TOKEN_ENCRYPTION_KEY`: separate secret for encrypting stored mailbox credentials and queued outbox payloads in SQLite (AES-256-GCM; defaults to `API_KEY`). Outbox payloads are purged immediately after send or cancel.
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`: server-level Google OAuth client credentials so you can authorize accounts in one click from extension options.
- `DISCORD_WEBHOOK_URL`, `DISCORD_DIGEST_HOUR`, `DISCORD_DIGEST_TIMEZONE`, and `IGNORED_IPS`: optional defaults for Discord webhook alerts, daily digests, and ignored IPs/CIDRs (also editable in extension options).

The tunnel's public hostname should point at `server:8787`. Data lives in the `data` volume.

## extension

```bash
pnpm install
pnpm --filter @open-mailtrack/extension build
```

`chrome://extensions` → Developer mode → Load unpacked → `packages/extension/dist`. Open the extension's options, enter your server URL, API key, and Undo Send delay, save, then connect each Gmail or Google Workspace account you use:
- **Google OAuth** (`https://mail.google.com/` scope, redirect URI `<PUBLIC_URL>/auth/google/callback`): works on personal Gmail (publish the OAuth consent screen to Production so refresh tokens do not expire after 7 days) and Workspace accounts that allow OAuth apps.
- **Google App Password** (SMTP + IMAP): works on personal Gmail and Workspace accounts where unverified OAuth apps are restricted (requires 2-Step Verification and App Passwords enabled).

After rebuilding an installed extension, reload it in `chrome://extensions` and reload Gmail.

## CLI

```bash
pnpm --filter @open-mailtrack/cli build
openmt auth --server https://t.example.com --api-key <API_KEY> \
  --sender-name "Your Name" --sender-email you@gmail.com \
  [--app-password "<16-char-app-password>"] [--client-id <id> --client-secret <secret>]

openmt send --input contacts.csv [--from you@cornell.edu] [--limit 20] [--delay 30] [--cc someone@example.com] [--dry-run]
openmt status [--since 7d] [--opened | --unopened] [--from you@gmail.com] [--json]
```

Columns: `contact_email`, `subject`, `body`. Attachments in a `files/` folder next to where you run the command are attached to every email.

## HTTP API

All `/api/*` endpoints require `Authorization: Bearer <API_KEY>`:

- `GET /api/accounts` — list connected accounts (never returns secrets)
- `POST /api/accounts/oauth/start`, `POST /api/accounts/oauth/import`, `POST /api/accounts/app-password`, `DELETE /api/accounts/:email` — manage connected Gmail / Workspace accounts
- `POST /api/outbox` — enqueue a tracked send (supports `undoDelayMs`, `sendAt`, `isScheduled`, `draftId`, `threadId`, `attachments`, `sync`)
- `GET /api/outbox`, `PATCH /api/outbox/:id` (reschedule / send now), `DELETE /api/outbox/:id` (cancel and restore Gmail draft)
- `GET /api/status?messageIds=...&threadIds=...` — message and thread open summaries including `appleMpp` and `recipientSummaries`
- `GET /api/messages`, `GET /api/messages/:id` — tracked messages and classified hits
- `GET /api/contacts`, `GET /api/contacts/:email` — per-contact open history and attribution
- `GET /api/settings`, `PATCH /api/settings` — server alert and IP ignore settings (Discord webhook stored encrypted and masked on read)
- `POST /api/notifications/test`, `POST /api/notifications/digest` — test Discord webhook and send an on-demand digest

## development

```bash
pnpm install && pnpm test && pnpm typecheck
API_KEY=dev pnpm dev:server                    # http://localhost:8787
pnpm --filter @open-mailtrack/extension dev    # rebuilds dist on change
```

## license

MIT
