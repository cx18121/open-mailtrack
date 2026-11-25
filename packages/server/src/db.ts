import { DatabaseSync } from "node:sqlite";

export type TrackingMode = "legacy" | "per_recipient";
export type RecipientKind = "to" | "cc" | "bcc";
export type AccountAuthType = "oauth" | "app_password";
export type OutboxStatus = "queued" | "sending" | "canceling" | "sent" | "canceled" | "failed";

export type RepliedByEntry = { email: string; at: number };

export type Message = {
  id: string;
  sender: string;
  recipients: string[];
  subject: string;
  source: "extension" | "cli";
  tracking_mode: TrackingMode;
  created_at: number;
  sent_at: number | null;
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  replied_at: number | null;
  replied_by: RepliedByEntry[];
  reply_checked_at: number | null;
  followup_dismissed_at: number | null;
  bounced_at: number | null;
  bounce_reason: string | null;
};

export type RecipientToken = {
  token: string;
  message_id: string;
  recipient: string;
  kind: RecipientKind;
  sent_at: number | null;
  smtp_message_id: string | null;
};

export type Hit = {
  id: number;
  message_id: string;
  recipient_token: string | null;
  at: number;
  ip: string | null;
  user_agent: string | null;
  headers: Record<string, string>;
};

export type Account = {
  email: string;
  auth_type: AccountAuthType;
  encrypted_credentials: string;
  display_name: string | null;
  created_at: number;
  updated_at: number;
};

export type OutboxRecipients = {
  to: string[];
  cc: string[];
  bcc: string[];
};

export type OutboxItem = {
  id: string;
  account_email: string;
  message_id: string;
  client_request_id: string | null;
  status: OutboxStatus;
  send_at: number;
  is_scheduled: boolean;
  cancel_on_reply: boolean;
  subject: string;
  recipients: OutboxRecipients;
  thread_id: string | null;
  draft_id: string | null;
  payload_encrypted: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};

const schema = `
create table if not exists messages (
  id text primary key,
  sender text not null,
  recipients text not null,
  subject text not null,
  source text not null,
  tracking_mode text not null default 'legacy',
  created_at integer not null,
  sent_at integer,
  gmail_message_id text,
  gmail_thread_id text,
  replied_at integer,
  replied_by text,
  reply_checked_at integer,
  followup_dismissed_at integer,
  bounced_at integer,
  bounce_reason text
);
create index if not exists messages_gmail_message_id on messages (gmail_message_id);
create index if not exists messages_gmail_thread_id on messages (gmail_thread_id);

create table if not exists recipient_tokens (
  token text primary key,
  message_id text not null,
  recipient text not null,
  kind text not null default 'to',
  sent_at integer,
  smtp_message_id text
);
create index if not exists recipient_tokens_message on recipient_tokens (message_id);
create index if not exists recipient_tokens_recipient on recipient_tokens (recipient);

create table if not exists hits (
  id integer primary key autoincrement,
  message_id text not null,
  recipient_token text,
  at integer not null,
  ip text,
  user_agent text,
  headers text not null
);
create index if not exists hits_message_id on hits (message_id, at);

create table if not exists message_views (
  id integer primary key autoincrement,
  gmail_message_id text not null,
  at integer not null
);
create index if not exists message_views_message on message_views (gmail_message_id, at);
drop table if exists self_views;

create table if not exists accounts (
  email text primary key,
  auth_type text not null,
  encrypted_credentials text not null,
  display_name text,
  created_at integer not null,
  updated_at integer not null
);

create table if not exists outbox (
  id text primary key,
  account_email text not null,
  message_id text not null,
  client_request_id text,
  status text not null,
  send_at integer not null,
  is_scheduled integer not null default 0,
  cancel_on_reply integer not null default 0,
  subject text not null,
  recipients_json text not null,
  thread_id text,
  draft_id text,
  payload_encrypted text,
  error text,
  created_at integer not null,
  updated_at integer not null
);
create index if not exists outbox_due on outbox (status, send_at);
create index if not exists outbox_account on outbox (account_email, status, send_at);

create table if not exists app_settings (
  key text primary key,
  value text not null,
  updated_at integer not null
);

create table if not exists notification_log (
  id integer primary key autoincrement,
  kind text not null,
  dedupe_key text not null unique,
  sent_at integer not null
);
create index if not exists notification_log_sent on notification_log (sent_at);
`;

type MessageRow = Omit<Message, "recipients" | "replied_by"> & {
  recipients: string;
  replied_by?: string | null;
  bounced_at?: number | null;
  bounce_reason?: string | null;
};
type HitRow = Omit<Hit, "headers"> & { headers: string };
type OutboxRow = Omit<OutboxItem, "is_scheduled" | "cancel_on_reply" | "recipients" | "payload_encrypted" | "client_request_id"> & {
  is_scheduled: number;
  cancel_on_reply?: number;
  recipients_json: string;
  payload_encrypted?: string | null;
  client_request_id?: string | null;
};

function parseRepliedBy(raw: string | null | undefined): RepliedByEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is RepliedByEntry =>
        Boolean(x) && typeof x.email === "string" && typeof x.at === "number" && Number.isFinite(x.at),
    );
  } catch {
    return [];
  }
}

const rowToMessage = (r: MessageRow): Message => ({
  ...r,
  tracking_mode: r.tracking_mode ?? "legacy",
  replied_at: r.replied_at ?? null,
  replied_by: parseRepliedBy(r.replied_by),
  reply_checked_at: r.reply_checked_at ?? null,
  followup_dismissed_at: r.followup_dismissed_at ?? null,
  bounced_at: r.bounced_at ?? null,
  bounce_reason: r.bounce_reason ?? null,
  recipients: JSON.parse(r.recipients),
});
const rowToHit = (r: HitRow): Hit => ({
  ...r,
  recipient_token: r.recipient_token ?? null,
  headers: JSON.parse(r.headers),
});
const rowToToken = (r: Partial<RecipientToken> & Pick<RecipientToken, "token" | "message_id" | "recipient" | "kind">): RecipientToken => ({
  ...r,
  sent_at: r.sent_at ?? null,
  smtp_message_id: r.smtp_message_id ?? null,
});
const rowToOutbox = (r: OutboxRow): OutboxItem => ({
  id: r.id,
  account_email: r.account_email,
  message_id: r.message_id,
  client_request_id: r.client_request_id ?? null,
  status: r.status,
  send_at: r.send_at,
  is_scheduled: r.is_scheduled === 1,
  cancel_on_reply: r.cancel_on_reply === 1,
  subject: r.subject,
  recipients: JSON.parse(r.recipients_json),
  thread_id: r.thread_id,
  draft_id: r.draft_id,
  payload_encrypted: r.payload_encrypted ?? null,
  error: r.error,
  created_at: r.created_at,
  updated_at: r.updated_at,
});

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const cols = db.prepare(`pragma table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

export function openDb(path: string) {
  const db = new DatabaseSync(path);
  db.exec("pragma journal_mode = wal");
  db.exec(schema);

  // Idempotent migrations for existing databases.
  if (!hasColumn(db, "messages", "tracking_mode")) {
    db.exec(`alter table messages add column tracking_mode text not null default 'legacy'`);
  }
  if (!hasColumn(db, "messages", "replied_at")) {
    db.exec(`alter table messages add column replied_at integer`);
  }
  if (!hasColumn(db, "messages", "reply_checked_at")) {
    db.exec(`alter table messages add column reply_checked_at integer`);
  }
  if (!hasColumn(db, "messages", "followup_dismissed_at")) {
    db.exec(`alter table messages add column followup_dismissed_at integer`);
  }
  if (!hasColumn(db, "messages", "replied_by")) {
    db.exec(`alter table messages add column replied_by text`);
  }
  if (!hasColumn(db, "messages", "bounced_at")) {
    db.exec(`alter table messages add column bounced_at integer`);
  }
  if (!hasColumn(db, "messages", "bounce_reason")) {
    db.exec(`alter table messages add column bounce_reason text`);
  }
  if (!hasColumn(db, "hits", "recipient_token")) {
    db.exec(`alter table hits add column recipient_token text`);
  }
  if (!hasColumn(db, "recipient_tokens", "sent_at")) {
    db.exec(`alter table recipient_tokens add column sent_at integer`);
  }
  if (!hasColumn(db, "recipient_tokens", "smtp_message_id")) {
    db.exec(`alter table recipient_tokens add column smtp_message_id text`);
  }
  if (!hasColumn(db, "outbox", "client_request_id")) {
    db.exec(`alter table outbox add column client_request_id text`);
  }
  if (!hasColumn(db, "outbox", "cancel_on_reply")) {
    db.exec(`alter table outbox add column cancel_on_reply integer not null default 0`);
  }
  db.exec(`create index if not exists hits_recipient_token on hits (recipient_token, at)`);
  db.exec(
    `create unique index if not exists outbox_client_request_id on outbox (account_email, client_request_id) where client_request_id is not null`,
  );

  function inTx<T>(fn: () => T): T {
    db.exec("begin immediate");
    try {
      const result = fn();
      db.exec("commit");
      return result;
    } catch (err) {
      db.exec("rollback");
      throw err;
    }
  }

  const insertMessage = db.prepare(
    `insert into messages (id, sender, recipients, subject, source, tracking_mode, created_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateSent = db.prepare(
    `update messages set sent_at = coalesce(sent_at, ?), gmail_message_id = ?, gmail_thread_id = ?
     where id = ? and (gmail_message_id is null or gmail_message_id = ?)
       and (gmail_thread_id is null or gmail_thread_id = ?)`,
  );
  const recoverSent = db.prepare(
    `update messages set sent_at = coalesce(sent_at, created_at), gmail_message_id = ?, gmail_thread_id = ?
     where id = ? and (gmail_message_id is null or gmail_message_id = ?)
       and (gmail_thread_id is null or gmail_thread_id = ?)`,
  );
  const deleteMessage = db.prepare(`delete from messages where id = ?`);
  const deleteTokensForMessage = db.prepare(`delete from recipient_tokens where message_id = ?`);
  const updateReplyCheckedStmt = db.prepare(
    `update messages set
       replied_at = coalesce(replied_at, ?),
       replied_by = coalesce(?, replied_by),
       bounced_at = coalesce(bounced_at, ?),
       bounce_reason = coalesce(bounce_reason, ?),
       reply_checked_at = ?
     where id = ?`,
  );
  const setFollowupDismissedStmt = db.prepare(
    `update messages set followup_dismissed_at = ? where id = ?`,
  );
  const selectMessage = db.prepare(`select * from messages where id = ?`);
  const selectMessages = db.prepare(`select * from messages order by created_at desc`);

  const insertToken = db.prepare(
    `insert into recipient_tokens (token, message_id, recipient, kind) values (?, ?, ?, ?)`,
  );
  const markTokenSentStmt = db.prepare(
    `update recipient_tokens set sent_at = ?, smtp_message_id = ? where token = ?`,
  );
  const selectToken = db.prepare(`select * from recipient_tokens where token = ?`);
  const selectTokensByMessage = db.prepare(`select * from recipient_tokens where message_id = ? order by rowid`);
  const selectAllTokens = db.prepare(`select * from recipient_tokens order by rowid`);

  const insertHit = db.prepare(
    `insert into hits (message_id, recipient_token, at, ip, user_agent, headers) values (?, ?, ?, ?, ?, ?)`,
  );
  const selectHits = db.prepare(`select * from hits where message_id = ? order by at`);
  const selectAllHits = db.prepare(`select * from hits order by at`);
  const insertView = db.prepare(`insert into message_views (gmail_message_id, at) values (?, ?)`);
  const selectViews = db.prepare(`select at from message_views where gmail_message_id = ? order by at`);
  const selectAllViews = db.prepare(`select gmail_message_id, at from message_views order by at`);

  const upsertSettingStmt = db.prepare(
    `insert into app_settings (key, value, updated_at) values (?, ?, ?)
     on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
  );
  const selectSettingStmt = db.prepare(`select value from app_settings where key = ?`);
  const selectAllSettingsStmt = db.prepare(`select key, value from app_settings`);
  const deleteSettingStmt = db.prepare(`delete from app_settings where key = ?`);

  const selectNotificationStmt = db.prepare(`select 1 as ok from notification_log where dedupe_key = ?`);
  const insertNotificationStmt = db.prepare(
    `insert or ignore into notification_log (kind, dedupe_key, sent_at) values (?, ?, ?)`,
  );
  const selectByGmailMessageIds = (n: number) =>
    db.prepare(`select * from messages where gmail_message_id in (${Array(n).fill("?").join(",")})`);
  const selectByGmailThreadIds = (n: number) =>
    db.prepare(`select * from messages where gmail_thread_id in (${Array(n).fill("?").join(",")})`);

  const upsertAccountStmt = db.prepare(
    `insert into accounts (email, auth_type, encrypted_credentials, display_name, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)
     on conflict(email) do update set
       auth_type = excluded.auth_type,
       encrypted_credentials = excluded.encrypted_credentials,
       display_name = coalesce(excluded.display_name, accounts.display_name),
       updated_at = excluded.updated_at`,
  );
  const selectAccountStmt = db.prepare(`select * from accounts where email = ?`);
  const selectAccountsStmt = db.prepare(`select * from accounts order by email`);
  const deleteAccountStmt = db.prepare(`delete from accounts where email = ?`);

  const insertOutboxStmt = db.prepare(
    `insert into outbox (
       id, account_email, message_id, client_request_id, status, send_at, is_scheduled, cancel_on_reply,
       subject, recipients_json, thread_id, draft_id, payload_encrypted, error, created_at, updated_at
     ) values (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?)`,
  );
  const selectOutboxStmt = db.prepare(`select * from outbox where id = ?`);
  const selectOutboxByClientReqStmt = db.prepare(
    `select * from outbox where account_email = ? and client_request_id = ?`,
  );
  const selectOneDueOutboxStmt = db.prepare(
    `select * from outbox where status = 'queued' and send_at <= ? order by send_at asc limit 1`,
  );
  const claimOutboxStmt = db.prepare(
    `update outbox set status = 'sending', error = null, updated_at = ? where id = ? and status = 'queued'`,
  );
  const completeOutboxStmt = db.prepare(
    `update outbox set status = 'sent', payload_encrypted = null, error = null, updated_at = ? where id = ?`,
  );
  const failOutboxStmt = db.prepare(
    `update outbox set status = 'failed', error = ?, updated_at = ? where id = ?`,
  );
  const beginCancelStmt = db.prepare(
    `update outbox set status = 'canceling', updated_at = ? where id = ? and status in ('queued', 'failed')`,
  );
  const abortCancelStmt = db.prepare(
    `update outbox set status = ?, updated_at = ? where id = ? and status = 'canceling'`,
  );
  const finishCancelStmt = db.prepare(
    `update outbox set status = 'canceled', payload_encrypted = null, error = null, updated_at = ?
     where id = ? and status = 'canceling'`,
  );
  const autoCancelOutboxStmt = db.prepare(
    `update outbox set status = 'canceled', payload_encrypted = null, error = null, updated_at = ?
     where id = ? and status = ?`,
  );
  const rescheduleOutboxStmt = db.prepare(
    `update outbox set status = 'queued', send_at = ?, error = null, updated_at = ?
     where id = ? and status in ('queued', 'failed')`,
  );
  const recoverStuckOutboxStmt = db.prepare(
    `update outbox set status = 'failed', error = ?, updated_at = ? where status in ('sending', 'canceling') and updated_at < ?`,
  );

  return {
    createMessage(
      m: Pick<Message, "id" | "sender" | "recipients" | "subject" | "source"> & { tracking_mode?: TrackingMode },
    ) {
      insertMessage.run(
        m.id,
        m.sender,
        JSON.stringify(m.recipients),
        m.subject,
        m.source,
        m.tracking_mode ?? "legacy",
        Date.now(),
      );
    },
    createMessageWithOutbox(args: {
      message: Pick<Message, "id" | "sender" | "recipients" | "subject" | "source"> & { tracking_mode: TrackingMode };
      tokens: Pick<RecipientToken, "token" | "message_id" | "recipient" | "kind">[];
      outbox: {
        id: string;
        account_email: string;
        message_id: string;
        client_request_id?: string | null;
        send_at: number;
        is_scheduled: boolean;
        cancel_on_reply?: boolean;
        subject: string;
        recipients: OutboxRecipients;
        thread_id?: string | null;
        draft_id?: string | null;
        payload_encrypted: string;
      };
    }) {
      return inTx(() => {
        const now = Date.now();
        insertMessage.run(
          args.message.id,
          args.message.sender,
          JSON.stringify(args.message.recipients),
          args.message.subject,
          args.message.source,
          args.message.tracking_mode,
          now,
        );
        for (const t of args.tokens) {
          insertToken.run(t.token, t.message_id, t.recipient.toLowerCase(), t.kind);
        }
        insertOutboxStmt.run(
          args.outbox.id,
          args.outbox.account_email.toLowerCase(),
          args.outbox.message_id,
          args.outbox.client_request_id ?? null,
          args.outbox.send_at,
          args.outbox.is_scheduled ? 1 : 0,
          args.outbox.cancel_on_reply ? 1 : 0,
          args.outbox.subject,
          JSON.stringify(args.outbox.recipients),
          args.outbox.thread_id ?? null,
          args.outbox.draft_id ?? null,
          args.outbox.payload_encrypted,
          now,
          now,
        );
      });
    },
    markSent(id: string, gmail: { messageId: string; threadId: string }, recover = false, sentAt = Date.now()) {
      const args = [gmail.messageId, gmail.threadId, id, gmail.messageId, gmail.threadId];
      return (recover ? recoverSent.run(...args) : updateSent.run(sentAt, ...args)).changes > 0;
    },
    getMessage(id: string) {
      const row = selectMessage.get(id) as MessageRow | undefined;
      return row ? rowToMessage(row) : null;
    },
    listMessages() {
      return (selectMessages.all() as MessageRow[]).map(rowToMessage);
    },
    listMessagesNeedingReplyCheck(opts: { sender?: string; sinceMs: number; staleBeforeMs: number; limit?: number }) {
      const clauses = [
        "gmail_thread_id is not null",
        "sent_at is not null",
        "sent_at >= ?",
        "followup_dismissed_at is null",
        "((replied_at is null and bounced_at is null) or (json_array_length(recipients) > 1 and (replied_by is null or json_array_length(replied_by) < json_array_length(recipients))))",
        "(reply_checked_at is null or reply_checked_at <= ?)",
      ];
      const params: (string | number)[] = [opts.sinceMs, opts.staleBeforeMs];
      if (opts.sender) {
        clauses.push("lower(sender) = ?");
        params.push(opts.sender.toLowerCase());
      }
      params.push(opts.limit ?? 40);
      const rows = db
        .prepare(
          `select * from messages where ${clauses.join(" and ")}
           order by coalesce(reply_checked_at, 0) asc, sent_at desc limit ?`,
        )
        .all(...params) as MessageRow[];
      return rows.map(rowToMessage);
    },
    markReplyChecked(
      id: string,
      repliedAt: number | null,
      checkedAt = Date.now(),
      extra?: { repliedBy?: RepliedByEntry[]; bouncedAt?: number | null; bounceReason?: string | null },
    ) {
      let repliedByJson: string | null = null;
      if (extra?.repliedBy && extra.repliedBy.length > 0) {
        const existing = selectMessage.get(id) as MessageRow | undefined;
        const merged = new Map<string, number>();
        for (const entry of parseRepliedBy(existing?.replied_by)) {
          merged.set(entry.email.toLowerCase(), entry.at);
        }
        for (const entry of extra.repliedBy) {
          const email = entry.email.toLowerCase();
          const prev = merged.get(email);
          if (prev === undefined || entry.at < prev) merged.set(email, entry.at);
        }
        repliedByJson = JSON.stringify(
          [...merged.entries()].map(([email, at]) => ({ email, at })).sort((a, b) => a.at - b.at),
        );
      }
      updateReplyCheckedStmt.run(
        repliedAt,
        repliedByJson,
        extra?.bouncedAt ?? null,
        extra?.bounceReason ?? null,
        checkedAt,
        id,
      );
    },
    setFollowupDismissed(id: string, dismissedAt: number | null) {
      return setFollowupDismissedStmt.run(dismissedAt, id).changes > 0;
    },
    createRecipientTokens(tokens: Pick<RecipientToken, "token" | "message_id" | "recipient" | "kind">[]) {
      for (const t of tokens) {
        insertToken.run(t.token, t.message_id, t.recipient.toLowerCase(), t.kind);
      }
    },
    markRecipientTokenSent(token: string, smtpMessageId: string, sentAt = Date.now()) {
      markTokenSentStmt.run(sentAt, smtpMessageId, token);
    },
    getRecipientToken(token: string) {
      const row = selectToken.get(token) as RecipientToken | undefined;
      return row ? rowToToken(row) : null;
    },
    listRecipientTokens(messageId: string) {
      return (selectTokensByMessage.all(messageId) as RecipientToken[]).map(rowToToken);
    },
    listAllRecipientTokens() {
      return (selectAllTokens.all() as RecipientToken[]).map(rowToToken);
    },
    recordHit(h: Omit<Hit, "id" | "at" | "recipient_token"> & { recipient_token?: string | null; at?: number }) {
      insertHit.run(
        h.message_id,
        h.recipient_token ?? null,
        h.at ?? Date.now(),
        h.ip,
        h.user_agent,
        JSON.stringify(h.headers),
      );
    },
    listHits(messageId: string) {
      return (selectHits.all(messageId) as HitRow[]).map(rowToHit);
    },
    listAllHits() {
      return (selectAllHits.all() as HitRow[]).map(rowToHit);
    },
    recordView(gmailMessageId: string) {
      insertView.run(gmailMessageId, Date.now());
    },
    listViews(gmailMessageId: string) {
      return (selectViews.all(gmailMessageId) as { at: number }[]).map((r) => r.at);
    },
    listAllViews() {
      return selectAllViews.all() as { gmail_message_id: string; at: number }[];
    },

    // App settings
    getSetting(key: string): string | null {
      const row = selectSettingStmt.get(key) as { value: string } | undefined;
      return row ? row.value : null;
    },
    setSetting(key: string, value: string) {
      upsertSettingStmt.run(key, value, Date.now());
    },
    deleteSetting(key: string) {
      deleteSettingStmt.run(key);
    },
    listSettings(): Record<string, string> {
      const out: Record<string, string> = {};
      for (const row of selectAllSettingsStmt.all() as { key: string; value: string }[]) {
        out[row.key] = row.value;
      }
      return out;
    },

    // Notification deduplication log
    hasNotification(dedupeKey: string): boolean {
      return Boolean(selectNotificationStmt.get(dedupeKey));
    },
    recordNotification(kind: string, dedupeKey: string, sentAt = Date.now()): boolean {
      return insertNotificationStmt.run(kind, dedupeKey, sentAt).changes > 0;
    },
    findByGmailMessageIds(ids: string[]) {
      return ids.length ? (selectByGmailMessageIds(ids.length).all(...ids) as MessageRow[]).map(rowToMessage) : [];
    },
    findByGmailThreadIds(ids: string[]) {
      return ids.length ? (selectByGmailThreadIds(ids.length).all(...ids) as MessageRow[]).map(rowToMessage) : [];
    },

    // Accounts
    upsertAccount(a: {
      email: string;
      auth_type: AccountAuthType;
      encrypted_credentials: string;
      display_name?: string | null;
    }) {
      const now = Date.now();
      upsertAccountStmt.run(a.email.toLowerCase(), a.auth_type, a.encrypted_credentials, a.display_name ?? null, now, now);
    },
    getAccount(email: string) {
      const row = selectAccountStmt.get(email.toLowerCase()) as Account | undefined;
      return row ?? null;
    },
    listAccounts() {
      return selectAccountsStmt.all() as Account[];
    },
    deleteAccount(email: string) {
      return deleteAccountStmt.run(email.toLowerCase()).changes > 0;
    },

    // Outbox
    getOutbox(id: string) {
      const row = selectOutboxStmt.get(id) as OutboxRow | undefined;
      return row ? rowToOutbox(row) : null;
    },
    getOutboxByClientRequestId(accountEmail: string, clientRequestId: string) {
      const row = selectOutboxByClientReqStmt.get(accountEmail.toLowerCase(), clientRequestId) as OutboxRow | undefined;
      return row ? rowToOutbox(row) : null;
    },
    /** Lists outbox metadata without loading encrypted attachment payloads. */
    listOutbox(opts: { accountEmail?: string; statuses?: OutboxStatus[] } = {}) {
      const clauses: string[] = [];
      const params: (string | number)[] = [];
      if (opts.accountEmail) {
        clauses.push("account_email = ?");
        params.push(opts.accountEmail.toLowerCase());
      }
      if (opts.statuses && opts.statuses.length > 0) {
        clauses.push(`status in (${opts.statuses.map(() => "?").join(",")})`);
        params.push(...opts.statuses);
      }
      const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
      const rows = db
        .prepare(
          `select id, account_email, message_id, client_request_id, status, send_at, is_scheduled, cancel_on_reply,
                  subject, recipients_json, thread_id, draft_id, error, created_at, updated_at
           from outbox ${where} order by send_at asc`,
        )
        .all(...params) as OutboxRow[];
      return rows.map(rowToOutbox);
    },
    listCancelOnReplyOutbox(opts: { accountEmail?: string; threadId?: string } = {}) {
      const clauses = ["status = 'queued'", "cancel_on_reply = 1", "thread_id is not null"];
      const params: (string | number)[] = [];
      if (opts.accountEmail) {
        clauses.push("account_email = ?");
        params.push(opts.accountEmail.toLowerCase());
      }
      if (opts.threadId) {
        clauses.push("thread_id = ?");
        params.push(opts.threadId);
      }
      const rows = db
        .prepare(
          `select id, account_email, message_id, client_request_id, status, send_at, is_scheduled, cancel_on_reply,
                  subject, recipients_json, thread_id, draft_id, error, created_at, updated_at
           from outbox where ${clauses.join(" and ")} order by send_at asc`,
        )
        .all(...params) as OutboxRow[];
      return rows.map(rowToOutbox);
    },
    /** Atomically cancels an unsent conditional follow-up and removes its tracking rows. */
    autoCancelOutbox(id: string, messageId: string, expectedStatus: "queued" | "sending"): boolean {
      return inTx(() => {
        const res = autoCancelOutboxStmt.run(Date.now(), id, expectedStatus);
        if (res.changes === 0) return false;
        deleteTokensForMessage.run(messageId);
        deleteMessage.run(messageId);
        return true;
      });
    },
    claimOneDueOutbox(now = Date.now()): OutboxItem | null {
      return inTx(() => {
        const row = selectOneDueOutboxStmt.get(now) as OutboxRow | undefined;
        if (!row) return null;
        if (claimOutboxStmt.run(now, row.id).changes === 0) return null;
        return { ...rowToOutbox(row), status: "sending", updated_at: now };
      });
    },
    claimOutboxById(id: string, now = Date.now()): OutboxItem | null {
      return inTx(() => {
        const row = selectOutboxStmt.get(id) as OutboxRow | undefined;
        if (!row || row.status !== "queued") return null;
        if (claimOutboxStmt.run(now, id).changes === 0) return null;
        return { ...rowToOutbox(row), status: "sending", updated_at: now };
      });
    },
    completeOutboxSent(id: string, messageId: string, gmail: { messageId: string; threadId: string }, sentAt = Date.now()) {
      inTx(() => {
        completeOutboxStmt.run(sentAt, id);
        updateSent.run(sentAt, gmail.messageId, gmail.threadId, messageId, gmail.messageId, gmail.threadId);
      });
    },
    failOutbox(id: string, error: string) {
      failOutboxStmt.run(error, Date.now(), id);
    },
    /** Two-phase cancel: locks the item in `canceling` while keeping its payload intact until draft restore succeeds. */
    beginCancelOutbox(id: string): { item: OutboxItem; previousStatus: "queued" | "failed" } | null {
      return inTx(() => {
        const row = selectOutboxStmt.get(id) as OutboxRow | undefined;
        if (!row || (row.status !== "queued" && row.status !== "failed")) return null;
        const previousStatus = row.status;
        if (beginCancelStmt.run(Date.now(), id).changes === 0) return null;
        return { item: rowToOutbox(row), previousStatus };
      });
    },
    abortCancelOutbox(id: string, previousStatus: "queued" | "failed") {
      abortCancelStmt.run(previousStatus, Date.now(), id);
    },
    finishCancelOutbox(id: string, messageId: string) {
      inTx(() => {
        finishCancelStmt.run(Date.now(), id);
        deleteTokensForMessage.run(messageId);
        deleteMessage.run(messageId);
      });
    },
    rescheduleOutbox(id: string, sendAt: number): boolean {
      return rescheduleOutboxStmt.run(sendAt, Date.now(), id).changes > 0;
    },
    recoverStuckSending(olderThanMs = 0) {
      const cutoff = Date.now() - olderThanMs;
      return recoverStuckOutboxStmt.run(
        "Server restarted while processing; verify in Gmail Sent before retrying",
        Date.now(),
        cutoff,
      ).changes;
    },
    close() {
      db.close();
    },
  };
}

export type Db = ReturnType<typeof openDb>;
