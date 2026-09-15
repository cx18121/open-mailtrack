import { DatabaseSync } from "node:sqlite";

export type Message = {
  id: string;
  sender: string;
  recipients: string[];
  subject: string;
  source: "extension" | "cli";
  created_at: number;
  sent_at: number | null;
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
};

export type Hit = {
  id: number;
  message_id: string;
  at: number;
  ip: string | null;
  user_agent: string | null;
  headers: Record<string, string>;
};

const schema = `
create table if not exists messages (
  id text primary key,
  sender text not null,
  recipients text not null,
  subject text not null,
  source text not null,
  created_at integer not null,
  sent_at integer,
  gmail_message_id text,
  gmail_thread_id text
);
create index if not exists messages_gmail_message_id on messages (gmail_message_id);

create table if not exists hits (
  id integer primary key autoincrement,
  message_id text not null references messages (id),
  at integer not null,
  ip text,
  user_agent text,
  headers text not null
);
create index if not exists hits_message_id on hits (message_id, at);
`;

type MessageRow = Omit<Message, "recipients"> & { recipients: string };
type HitRow = Omit<Hit, "headers"> & { headers: string };

const rowToMessage = (r: MessageRow): Message => ({ ...r, recipients: JSON.parse(r.recipients) });
const rowToHit = (r: HitRow): Hit => ({ ...r, headers: JSON.parse(r.headers) });

export function openDb(path: string) {
  const db = new DatabaseSync(path);
  db.exec("pragma journal_mode = wal");
  db.exec(schema);

  const insertMessage = db.prepare(
    `insert into messages (id, sender, recipients, subject, source, created_at)
     values (?, ?, ?, ?, ?, ?)`,
  );
  const updateSent = db.prepare(
    `update messages set sent_at = ?, gmail_message_id = ?, gmail_thread_id = ? where id = ?`,
  );
  const selectMessage = db.prepare(`select * from messages where id = ?`);
  const selectMessages = db.prepare(`select * from messages order by created_at desc`);
  const insertHit = db.prepare(
    `insert into hits (message_id, at, ip, user_agent, headers) values (?, ?, ?, ?, ?)`,
  );
  const selectHits = db.prepare(`select * from hits where message_id = ? order by at`);

  return {
    createMessage(m: Pick<Message, "id" | "sender" | "recipients" | "subject" | "source">) {
      insertMessage.run(m.id, m.sender, JSON.stringify(m.recipients), m.subject, m.source, Date.now());
    },
    markSent(id: string, gmail: { messageId: string; threadId: string }) {
      return updateSent.run(Date.now(), gmail.messageId, gmail.threadId, id).changes > 0;
    },
    getMessage(id: string) {
      const row = selectMessage.get(id) as MessageRow | undefined;
      return row ? rowToMessage(row) : null;
    },
    listMessages() {
      return (selectMessages.all() as MessageRow[]).map(rowToMessage);
    },
    recordHit(h: Omit<Hit, "id" | "at">) {
      insertHit.run(h.message_id, Date.now(), h.ip, h.user_agent, JSON.stringify(h.headers));
    },
    listHits(messageId: string) {
      return (selectHits.all(messageId) as HitRow[]).map(rowToHit);
    },
    close() {
      db.close();
    },
  };
}

export type Db = ReturnType<typeof openDb>;
