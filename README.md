# open-mailtrack

Self-hosted open tracking for mail you send from Gmail. Three parts:

- **server**: records tracking pixel hits and tells the extension which messages were opened. Node, SQLite, one Docker container.
- **extension**: Chrome extension for Gmail. Adds the pixel to mail you send, shows `✓` / `✓✓ N` in your Sent list and on your messages, and keeps your own views from counting as opens.
- **cli** (`openmt`): sends tracked mail from a CSV or XLSX through the Gmail API, for scripts and agents. Those messages show up in the same Sent list marks.

Everything runs on infrastructure you control. Nothing about your mail leaves it except the pixel hits recipients' mail clients make to your server.

## How opens are counted

A tracked message carries a 1×1 image hosted on your server. When a recipient's mail client renders the message, it fetches the image and the server records a hit. The extension and CLI register each message with the server before sending and attach the Gmail message ID after, so status lookups are exact.

Measured behavior for Gmail and Google Workspace recipients, which the classification rules are built from:

- Gmail fetches through `GoogleImageProxy`. No delivery-time prefetch was observed; the first hit is the first open.
- Reopening a message in the same Gmail tab session does not refetch. A new session, tab, device, or the phone app does. The count is best read as sessions, not glances.
- Your own views of a sent message also fetch the pixel. The extension tells the server when you view a message, and hits within a few seconds are classified as self views and excluded.
- Every hit is stored with its full request evidence and classified on read, so rules can change without losing data.

Other clients (Apple Mail with Mail Privacy Protection, corporate scanners) prefetch images and will show as opens until a rule for them exists. Recipients who block remote images never show as opened. Repeat counts are a floor.

## Self-hosting

You need a public HTTPS hostname for the pixel. The included compose file uses a Cloudflare Tunnel so no inbound ports are opened.

```bash
git clone https://github.com/cx18121/open-mailtrack.git
cd open-mailtrack/deploy
cp .env.example .env
```

Fill in `.env`:

- `API_KEY`: any long random string. The extension and CLI send it as a bearer token.
- `PUBLIC_URL`: `https://t.example.com`, the hostname recipients will fetch the pixel from.
- `TUNNEL_TOKEN`: from Cloudflare Zero Trust → Networks → Tunnels → Create a tunnel. Add a public hostname pointing at `server:8787`.

```bash
docker compose up -d --build
curl -I https://t.example.com/p/AAAAAAAAAAAAAAAAAAAAAA.gif   # 200 image/gif
```

Data lives in the `data` volume as one SQLite file.

## Extension

```bash
pnpm install
pnpm --filter @open-mailtrack/extension build
```

In Chrome: `chrome://extensions` → Developer mode → Load unpacked → `packages/extension/dist`. Open the extension's options and enter the server URL and API key. Reload Gmail.

Tracking is on by default for every send, including replies and forwards. The double-check button in the compose toolbar turns it off for that message. Mail addressed only to yourself is never tracked.

After a rebuild, click reload on the extension card and refresh Gmail.

## CLI

The CLI sends through the Gmail API with your own Google OAuth client, using only the `gmail.send` scope.

1. Google Cloud Console → new project → enable the Gmail API.
2. OAuth consent screen → External → add your Gmail address as a test user.
3. Credentials → Create OAuth client ID → Desktop app. Note the client ID and secret.
4. Publish the consent screen (OAuth consent screen → Publishing status → Publish). Apps left in Testing get refresh tokens that expire after 7 days. `gmail.send` does not require verification; you will see an "unverified app" warning once during sign-in, which is expected for a personal app.

```bash
pnpm --filter @open-mailtrack/cli build
node packages/cli/dist/index.js auth \
  --server https://t.example.com --api-key <API_KEY> \
  --client-id <id> --client-secret <secret> \
  --sender-name "Your Name" --sender-email you@gmail.com
```

Config is written to `~/.config/open-mailtrack/config.json`.

```bash
openmt send --input contacts.csv [--limit 20] [--delay 30] [--cc someone@example.com] [--dry-run]
```

Input columns: `contact_email` (or `email`), `subject`, `body`. CSV or XLSX. Every file in a `files/` folder next to where you run the command is attached to every email. The plain text body is also rendered as HTML with links made clickable so the pixel can be included.

## HTTP API

Anything that can send email can use the server directly. All `/api` routes take `Authorization: Bearer <API_KEY>`.

```bash
# Register a message. Returns { id, pixelUrl }. Put <img src="pixelUrl" width="1" height="1"> in the HTML body.
curl -X POST https://t.example.com/api/messages -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"sender":"you@gmail.com","recipients":["them@example.com"],"subject":"Hello","source":"cli"}'

# After sending through the Gmail API, attach the ids so the extension can show status.
curl -X PATCH https://t.example.com/api/messages/<id> -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"gmailMessageId":"...","gmailThreadId":"..."}'

# Status for the extension, by Gmail ids.
curl "https://t.example.com/api/status?messageIds=a,b&threadIds=c" -H "authorization: Bearer $KEY"

# Everything recorded for one message, with each hit's classification.
curl https://t.example.com/api/messages/<id> -H "authorization: Bearer $KEY"
```

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm dev:server                                     # http://localhost:8787, needs API_KEY in the environment
pnpm --filter @open-mailtrack/extension dev         # rebuilds dist on change
```

Recipients are not told they are being tracked. Some jurisdictions treat this as requiring consent; that is your call as the operator.

MIT.
