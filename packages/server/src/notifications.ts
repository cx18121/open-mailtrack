import type { OpenSummary } from "./classify.js";
import type { Db, Message, OutboxItem } from "./db.js";
import type { SettingsStore } from "./settings.js";

const COLOR_OPEN = 0x188038;
const COLOR_HOT = 0xe37400;
const COLOR_REVIVAL = 0x1a73e8;
const COLOR_BOUNCE = 0xd93025;
const COLOR_DIGEST = 0x5f6368;

const HOT_MILESTONES = new Set([3, 5, 10]);
const DIGEST_CHECK_INTERVAL_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
const FOLLOWUP_MIN_AGE_MS = DAY_MS;
const FOLLOWUP_MAX_AGE_MS = 30 * DAY_MS;

type DiscordEmbedField = { name: string; value: string; inline?: boolean };
type DiscordEmbed = {
  title: string;
  description?: string;
  url?: string;
  color: number;
  fields?: DiscordEmbedField[];
  footer?: { text: string };
  timestamp?: string;
};

export type DigestMessageView = Message & OpenSummary;

export type NotifierOptions = {
  db: Db;
  settings: SettingsStore;
  fetchImpl?: typeof fetch;
  /** Supplies summarized sent messages (excluding unsent outbox rows) for daily digest generation. */
  listDigestMessages: () => DigestMessageView[];
  digestCheckIntervalMs?: number;
};

function truncate(text: string, max: number): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

function gmailThreadUrl(threadId: string | null | undefined): string | undefined {
  if (!threadId) return undefined;
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`;
}

function localDateAndHour(now: number, timeZone: string): { dateKey: string; hour: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
    }).formatToParts(new Date(now));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    const hourNum = Number(get("hour")) % 24;
    return { dateKey: `${get("year")}-${get("month")}-${get("day")}`, hour: Number.isFinite(hourNum) ? hourNum : 0 };
  } catch {
    const d = new Date(now);
    const pad = (n: number) => String(n).padStart(2, "0");
    return {
      dateKey: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
      hour: d.getUTCHours(),
    };
  }
}

export function createNotifier(opts: NotifierOptions) {
  const { db, settings, listDigestMessages } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const digestCheckIntervalMs = opts.digestCheckIntervalMs ?? DIGEST_CHECK_INTERVAL_MS;

  const inFlightKeys = new Set<string>();
  let digestTimer: ReturnType<typeof setInterval> | null = null;

  async function postDiscord(webhookUrl: string, embeds: DiscordEmbed[]): Promise<void> {
    const res = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "open-mailtrack",
        embeds,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Discord webhook HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
  }

  async function sendOnce(kind: string, dedupeKeys: string[], embed: DiscordEmbed): Promise<boolean> {
    const s = settings.load();
    if (!s.discordWebhookUrl) return false;
    const primaryKey = dedupeKeys[0];
    if (!primaryKey) return false;
    if (inFlightKeys.has(primaryKey) || db.hasNotification(primaryKey)) return false;

    for (const k of dedupeKeys) inFlightKeys.add(k);
    try {
      await postDiscord(s.discordWebhookUrl, [embed]);
      for (const k of dedupeKeys) db.recordNotification(kind, k);
      return true;
    } finally {
      for (const k of dedupeKeys) inFlightKeys.delete(k);
    }
  }

  async function notifyOpen(args: {
    message: Message;
    summary: OpenSummary;
    recipient: string | null;
    client: string | null;
    at: number;
  }): Promise<boolean> {
    const s = settings.load();
    if (!s.discordWebhookUrl) return false;
    const { message, summary, recipient, client, at } = args;
    if (summary.opens <= 0) return false;

    const recipientKey = (recipient ?? message.recipients[0] ?? "any").toLowerCase();
    const recipientDisplay = recipient ?? (message.recipients.join(", ") || "Unknown recipient");
    const subject = message.subject || "(no subject)";
    const url = gmailThreadUrl(message.gmail_thread_id);
    const dayBucket = Math.floor(at / DAY_MS);

    const fields: DiscordEmbedField[] = [{ name: "Recipient", value: truncate(recipientDisplay, 200), inline: true }];
    if (client) fields.push({ name: "Client", value: client, inline: true });
    if (summary.opens > 1) fields.push({ name: "Opens", value: String(summary.opens), inline: true });

    const base = {
      url,
      fields,
      footer: { text: message.sender },
      timestamp: new Date(at).toISOString(),
    };

    // 1. First open (including first open that happened 2+ days after sending).
    if (summary.opens === 1) {
      const isLateFirst = summary.late?.kind === "after_send";
      if (isLateFirst && (s.notifyRevival || s.notifyFirstOpen)) {
        const keys = [
          `first_open:${message.id}:${recipientKey}`,
          `revival:${message.id}:${recipientKey}:${dayBucket}`,
        ];
        return sendOnce("revival", keys, {
          ...base,
          title: truncate(`Opened after ${summary.late!.days}d: ${subject}`, 256),
          color: COLOR_REVIVAL,
        });
      }
      if (s.notifyFirstOpen) {
        return sendOnce("first_open", [`first_open:${message.id}:${recipientKey}`], {
          ...base,
          title: truncate(`Opened: ${subject}`, 256),
          color: COLOR_OPEN,
        });
      }
      return false;
    }

    // 2. Revival (reopened after 2+ days since previous open).
    if (summary.late?.kind === "after_previous" && s.notifyRevival) {
      const sent = await sendOnce("revival", [`revival:${message.id}:${recipientKey}:${dayBucket}`], {
        ...base,
        title: truncate(`Reopened after ${summary.late.days}d: ${subject}`, 256),
        color: COLOR_REVIVAL,
      });
      if (sent) return true;
    }

    // 3. Hot spike milestones (3, 5, 10 opens).
    if (HOT_MILESTONES.has(summary.opens) && s.notifyHotSpike) {
      return sendOnce("hot", [`hot:${message.id}:${recipientKey}:${summary.opens}`], {
        ...base,
        title: truncate(`Hot (${summary.opens} opens): ${subject}`, 256),
        color: COLOR_HOT,
      });
    }

    return false;
  }

  async function notifyBounce(args: { message: Message; bouncedAt: number; reason: string | null }): Promise<boolean> {
    const s = settings.load();
    if (!s.discordWebhookUrl || !s.notifyBounce) return false;
    const { message, bouncedAt, reason } = args;
    const subject = message.subject || "(no subject)";
    const fields: DiscordEmbedField[] = [
      { name: "Recipients", value: truncate(message.recipients.join(", ") || "Unknown", 200), inline: true },
    ];
    if (reason) fields.push({ name: "Reason", value: truncate(reason, 300), inline: false });
    return sendOnce("bounce", [`bounce:${message.id}`], {
      title: truncate(`Bounced: ${subject}`, 256),
      url: gmailThreadUrl(message.gmail_thread_id),
      color: COLOR_BOUNCE,
      fields,
      footer: { text: message.sender },
      timestamp: new Date(bouncedAt).toISOString(),
    });
  }

  async function notifyAutoCanceled(args: {
    item: OutboxItem;
    repliedAt: number;
    repliedBy: string[];
  }): Promise<boolean> {
    const s = settings.load();
    if (!s.discordWebhookUrl) return false;
    const { item, repliedAt, repliedBy } = args;
    const subject = item.subject || "(no subject)";
    const recipients = [...item.recipients.to, ...item.recipients.cc, ...item.recipients.bcc];
    const fields: DiscordEmbedField[] = [
      { name: "Recipients", value: truncate(recipients.join(", ") || "Unknown", 200), inline: true },
    ];
    if (repliedBy.length > 0) {
      fields.push({ name: "Reply from", value: truncate(repliedBy.join(", "), 200), inline: true });
    }
    return sendOnce("auto_cancel", [`auto_cancel:${item.id}`], {
      title: truncate(`Canceled follow-up (reply received): ${subject}`, 256),
      url: gmailThreadUrl(item.thread_id),
      color: COLOR_REVIVAL,
      fields,
      footer: { text: item.account_email },
      timestamp: new Date(repliedAt).toISOString(),
    });
  }

  function buildDigestEmbed(now: number, dateKey: string): { embed: DiscordEmbed; hasContent: boolean } {
    const all = listDigestMessages();
    const since24h = now - DAY_MS;

    const sent24h = all.filter((m) => (m.sent_at ?? m.created_at) >= since24h);
    const opened24h = all.filter((m) => (m.lastOpenAt ?? 0) >= since24h && m.opens > 0);
    const replied24h = all.filter((m) => (m.replied_at ?? 0) >= since24h);
    const bounced24h = all.filter((m) => (m.bounced_at ?? 0) >= since24h);

    const openRate =
      sent24h.length > 0
        ? Math.round((sent24h.filter((m) => m.opens > 0).length / sent24h.length) * 100)
        : null;

    const hotOrRevived = opened24h
      .filter((m) => m.opens >= 3 || m.late !== null)
      .sort((a, b) => (b.lastOpenAt ?? 0) - (a.lastOpenAt ?? 0))
      .slice(0, 5);

    const needsFollowup = all
      .filter((m) => {
        const fullyBounced = Boolean(m.bounced_at) && m.recipients.length <= 1;
        if (m.replied_at || fullyBounced || m.followup_dismissed_at) return false;
        const age = now - (m.sent_at ?? m.created_at);
        return age >= FOLLOWUP_MIN_AGE_MS && age <= FOLLOWUP_MAX_AGE_MS;
      })
      .sort((a, b) => {
        const aOpened = a.opens > 0 ? 1 : 0;
        const bOpened = b.opens > 0 ? 1 : 0;
        if (bOpened !== aOpened) return bOpened - aOpened;
        return (b.lastOpenAt ?? b.sent_at ?? b.created_at) - (a.lastOpenAt ?? a.sent_at ?? a.created_at);
      })
      .slice(0, 5);

    const hasContent =
      sent24h.length > 0 ||
      opened24h.length > 0 ||
      replied24h.length > 0 ||
      bounced24h.length > 0 ||
      needsFollowup.length > 0;

    const formatLine = (m: DigestMessageView, note: string) => {
      const subj = truncate(m.subject || "(no subject)", 55);
      const who = truncate(m.recipients[0] ?? "", 32);
      const url = gmailThreadUrl(m.gmail_thread_id);
      const titlePart = url ? `[${subj}](${url})` : subj;
      return `• ${titlePart} — ${who} (${note})`;
    };

    const fields: DiscordEmbedField[] = [
      {
        name: "Last 24 hours",
        value: [
          `Sent: **${sent24h.length}**${openRate !== null ? ` (${openRate}% opened)` : ""}`,
          `Active opens: **${opened24h.length}**`,
          `Replies: **${replied24h.length}**`,
          bounced24h.length > 0 ? `Bounced: **${bounced24h.length}**` : null,
        ]
          .filter(Boolean)
          .join(" · "),
        inline: false,
      },
    ];

    if (hotOrRevived.length > 0) {
      fields.push({
        name: "Hot & reopened",
        value: hotOrRevived
          .map((m) =>
            formatLine(
              m,
              m.late ? `reopened after ${m.late.days}d, ${m.opens} opens` : `${m.opens} opens`,
            ),
          )
          .join("\n"),
        inline: false,
      });
    }

    if (needsFollowup.length > 0) {
      fields.push({
        name: "Needs follow-up",
        value: needsFollowup
          .map((m) => {
            const days = Math.max(1, Math.floor((now - (m.sent_at ?? m.created_at)) / DAY_MS));
            const status = m.opens > 0 ? `${m.opens} opens, no reply` : "unopened";
            return formatLine(m, `${days}d ago · ${status}`);
          })
          .join("\n"),
        inline: false,
      });
    }

    return {
      hasContent,
      embed: {
        title: `Daily email digest (${dateKey})`,
        description: hasContent ? undefined : "No tracked email activity in the last 24 hours.",
        color: COLOR_DIGEST,
        fields,
        timestamp: new Date(now).toISOString(),
      },
    };
  }

  async function sendDigest(options: { force?: boolean; now?: number } = {}): Promise<{ sent: boolean; skipped?: string }> {
    const s = settings.load();
    if (!s.discordWebhookUrl) return { sent: false, skipped: "no_webhook" };
    const now = options.now ?? Date.now();
    const { dateKey, hour } = localDateAndHour(now, s.digestTimezone);
    const dedupeKey = `digest:${dateKey}`;

    if (!options.force) {
      if (!s.digestEnabled) return { sent: false, skipped: "disabled" };
      if (hour < s.digestHour) return { sent: false, skipped: "before_hour" };
      if (inFlightKeys.has(dedupeKey) || db.hasNotification(dedupeKey)) {
        return { sent: false, skipped: "already_sent" };
      }
    }

    const { embed, hasContent } = buildDigestEmbed(now, dateKey);
    if (!options.force && !hasContent) {
      db.recordNotification("digest", dedupeKey, now);
      return { sent: false, skipped: "empty" };
    }

    if (options.force) {
      await postDiscord(s.discordWebhookUrl, [embed]);
      return { sent: true };
    }

    inFlightKeys.add(dedupeKey);
    try {
      await postDiscord(s.discordWebhookUrl, [embed]);
      db.recordNotification("digest", dedupeKey, now);
      return { sent: true };
    } finally {
      inFlightKeys.delete(dedupeKey);
    }
  }

  async function sendTest(webhookUrlOverride?: string): Promise<void> {
    const url = webhookUrlOverride?.trim() || settings.load().discordWebhookUrl;
    if (!url) throw new Error("No Discord webhook URL configured");
    await postDiscord(url, [
      {
        title: "open-mailtrack test alert",
        description: "Discord webhook notifications are connected and ready.",
        color: COLOR_OPEN,
        timestamp: new Date().toISOString(),
      },
    ]);
  }

  return {
    notifyOpen,
    notifyBounce,
    notifyAutoCanceled,
    sendDigest,
    sendTest,
    start() {
      const initial = setTimeout(() => void sendDigest().catch((err) => console.error("[open-mailtrack] digest failed:", err)), 30_000);
      initial.unref?.();
      digestTimer = setInterval(
        () => void sendDigest().catch((err) => console.error("[open-mailtrack] digest failed:", err)),
        digestCheckIntervalMs,
      );
      digestTimer.unref?.();
    },
    stop() {
      if (digestTimer) {
        clearInterval(digestTimer);
        digestTimer = null;
      }
    },
  };
}

export type Notifier = ReturnType<typeof createNotifier>;
