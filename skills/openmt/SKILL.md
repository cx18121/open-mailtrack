---
name: openmt
description: Send tracked email and read open status with the open-mailtrack CLI. Use when asked to send outreach through openmt or to check whether tracked mail was opened.
disable-model-invocation: true
---

# openmt

`openmt --help` owns the exact flags. Config, including the Gmail token and server, is already set up by `openmt auth`; do not re-run it unless a command fails with a token or config error.

## Sending

1. Write the batch to a CSV with columns `contact_email`, `subject`, `body`. Body is plain text; newlines are kept and URLs become links. Files in a `files/` folder next to the CSV are attached to every email, so check that folder before sending.
2. Run `openmt send --input <file> --dry-run` and show the output. Sending real mail needs the user's explicit go.
3. Send with `openmt send --input <file> --delay 30`. Keep `--delay` at 30 or more for batches; Gmail throttles bursts. Use `--limit` to send a subset first when the batch is large or the copy is new.
4. Report sent and failed counts. A 401 or 403 stops the run; report it rather than retrying.

## Reading status

- `openmt status` lists tracked messages, most recently opened first. `--unopened`, `--opened`, `--since 7d`, and `--sender you@gmail.com` narrow it. `--json` for processing.
- Wait at least a minute after sending before reading status. Gmail fetches images right after a send lands in an existing thread; the server classifies those as prefetch, not opens, but only once they have arrived.
- An open count is a floor. Gmail serves repeat views from cache, so "opened once" can mean several reads in one session. "Not opened" can mean images are blocked.
- Do not describe an open as a read receipt to the user or in drafted mail. Say "opened" and give the time.

## Follow-ups

When drafting a follow-up, pull `openmt status --json`, match on `recipients` and `subject`, and use `lastOpenAt` and `opens` as context. Never mention tracking to the recipient.
