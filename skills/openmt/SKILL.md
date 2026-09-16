---
name: openmt
description: Send tracked email and read open status with the open-mailtrack CLI.
disable-model-invocation: true
---

# openmt

`openmt --help` owns the flags. `openmt auth` is already done; reach for it only after a token or config error.

## Send

1. Write the batch as a CSV with columns `contact_email`, `subject`, `body`. Body is plain text. List the `files/` folder next to the CSV, since every file in it is attached to every email.
2. Dry run and show the user what would go out. The user says go; then send.
3. Send with `--delay` of 30 seconds or more. For a large batch or fresh copy, send a `--limit` slice first.

## Read status

- `openmt status` lists tracked mail, most recently opened first. `--json` for processing.
- Read status a minute or more after sending. Gmail fetches images right after a send lands in an existing thread and the server sorts those out only once they arrive.
- An open count is a floor and "not opened" can mean images are blocked. Report an open as "opened at <time>", nothing stronger.

## Follow-ups

Pull `openmt status --json`, match on `recipients` and `subject`, and use `lastOpenAt` and `opens` to decide timing. The recipient's mail stays free of any mention of tracking.
