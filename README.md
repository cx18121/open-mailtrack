# open-mailtrack

Self-hosted open tracking for Gmail.

- **server**: records tracking pixel hits. Node, SQLite, one Docker container.
- **extension**: adds the pixel to mail you send from Gmail and shows ✓ / ✓✓ in your Sent list and on each message.
- **cli** (`openmt`): sends tracked mail from a CSV or XLSX through the Gmail API. Shows up in the same Sent list marks.

## What the marks mean

A tracked message carries a 1×1 image on your server. When the recipient's client renders the message, the server records a hit. Measured against Gmail and Google Workspace recipients:

- The first hit is a real open. Gmail does not prefetch at delivery.
- Reopening in the same Gmail tab does not refetch; a new session or device does. Read the count as sessions, not glances.
- Your own views are reported by the extension and excluded.
- Recipients who block images never show as opened. Clients that prefetch images (Apple Mail with Mail Privacy Protection, some corporate scanners) show as opened until a rule for them exists. Every hit is stored raw and classified on read, so rules can change later.

## Server

You need a public HTTPS hostname. The compose file uses a Cloudflare Tunnel so nothing inbound is opened.

```bash
git clone https://github.com/cx18121/open-mailtrack.git
cd open-mailtrack/deploy
cp .env.example .env   # API_KEY (any long secret), PUBLIC_URL (https://t.example.com), TUNNEL_TOKEN
docker compose up -d --build
```

The tunnel's public hostname should point at `server:8787`. Data lives in the `data` volume.

## Extension

```bash
pnpm install
pnpm --filter @open-mailtrack/extension build
```

`chrome://extensions` → Developer mode → Load unpacked → `packages/extension/dist`. Enter the server URL and API key in the extension's options, then reload Gmail.

Tracking is on for every send, including replies. The double-check button in the compose toolbar turns it off for one message. Mail addressed only to yourself is never tracked.

## CLI

Create a Google OAuth client: Cloud Console → enable the Gmail API → OAuth consent screen (External, add yourself as a test user, then **Publish** so tokens do not expire after 7 days) → Credentials → OAuth client ID → Desktop app. Only the `gmail.send` scope is used; the one-time "unverified app" warning is expected.

```bash
pnpm --filter @open-mailtrack/cli build
openmt auth --server https://t.example.com --api-key <API_KEY> \
  --client-id <id> --client-secret <secret> --sender-name "Your Name" --sender-email you@gmail.com

openmt send --input contacts.csv [--limit 20] [--delay 30] [--cc someone@example.com] [--dry-run]
```

Columns: `contact_email`, `subject`, `body`. Files in a `files/` folder next to where you run the command are attached to every email.

## HTTP API

Any sender can use the server directly with `Authorization: Bearer <API_KEY>`:

- `POST /api/messages` `{sender, recipients, subject}` → `{id, pixelUrl}`. Put `<img src="pixelUrl" width="1" height="1">` in the HTML body.
- `PATCH /api/messages/:id` `{gmailMessageId, gmailThreadId}` after sending, so the extension can show status.
- `GET /api/messages/:id` for every hit and its classification.

## Development

```bash
pnpm install && pnpm test && pnpm typecheck
API_KEY=dev pnpm dev:server                    # http://localhost:8787
pnpm --filter @open-mailtrack/extension dev    # rebuilds dist on change
```

Recipients are not told they are being tracked. Whether that needs consent depends on where you and they are.

## License

MIT
