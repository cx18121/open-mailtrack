import type { Cipher } from "./crypto.js";
import type { Account, Db, Message } from "./db.js";
import { defaultTransportFactory, type TransportFactory } from "./outbox.js";

const LOOKBACK_MS = 30 * 86_400_000;
const DEFAULT_STALE_MS = 5 * 60_000;
const DEFAULT_INTERVAL_MS = 10 * 60_000;

export type ReplyCheckerOptions = {
  db: Db;
  cipher: Cipher;
  transportFactory?: TransportFactory;
  staleMs?: number;
  intervalMs?: number;
  onBounce?: (args: { message: Message; bouncedAt: number; reason: string | null }) => void;
};

export function createReplyChecker(opts: ReplyCheckerOptions) {
  const { db, cipher } = opts;
  const getTransport = (account: Account) => (opts.transportFactory ?? defaultTransportFactory)(account, cipher);
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function check(params: { sender?: string; force?: boolean; limit?: number } = {}): Promise<{
    checked: number;
    replied: number;
    bounced: number;
  }> {
    if (running) return { checked: 0, replied: 0, bounced: 0 };
    running = true;
    let checked = 0;
    let replied = 0;
    let bounced = 0;
    try {
      const now = Date.now();
      const candidates = db.listMessagesNeedingReplyCheck({
        sender: params.sender,
        sinceMs: now - LOOKBACK_MS,
        staleBeforeMs: params.force ? now : now - staleMs,
        limit: params.limit ?? 30,
      });
      if (candidates.length === 0) return { checked: 0, replied: 0, bounced: 0 };

      // Group by (sender, gmail_thread_id) so we only call Gmail once per thread.
      const bySenderThread = new Map<string, Message[]>();
      for (const m of candidates) {
        const key = `${m.sender.toLowerCase()}::${m.gmail_thread_id}`;
        const list = bySenderThread.get(key) ?? [];
        list.push(m);
        bySenderThread.set(key, list);
      }

      const transports = new Map<string, ReturnType<typeof getTransport> | null>();
      for (const [, msgs] of bySenderThread) {
        const sender = msgs[0].sender.toLowerCase();
        if (!transports.has(sender)) {
          const account = db.getAccount(sender);
          transports.set(sender, account ? getTransport(account) : null);
        }
        const transport = transports.get(sender);
        if (!transport?.inspectThreadActivity && !transport?.getThreadReplyAt) continue;

        const threadId = msgs[0].gmail_thread_id!;
        const earliestSent = Math.min(...msgs.map((m) => m.sent_at ?? m.created_at));
        try {
          const checkedAt = Date.now();
          if (transport.inspectThreadActivity) {
            const earliestActivity = await transport.inspectThreadActivity(threadId, earliestSent, sender);
            for (const m of msgs) {
              const mSent = m.sent_at ?? m.created_at;
              let activity = earliestActivity;
              if (
                (earliestActivity.repliedAt !== null && earliestActivity.repliedAt <= mSent) ||
                (earliestActivity.bouncedAt !== null && earliestActivity.bouncedAt <= mSent)
              ) {
                activity = await transport.inspectThreadActivity(threadId, mSent, sender);
              }
              const repliedByAfter = activity.repliedBy.filter((r) => r.at > mSent);
              const replyAt = repliedByAfter.length > 0 ? repliedByAfter[0].at : activity.repliedAt && activity.repliedAt > mSent ? activity.repliedAt : null;
              const bouncedAt = activity.bouncedAt && activity.bouncedAt > mSent ? activity.bouncedAt : null;
              const bounceReason = bouncedAt ? activity.bounceReason : null;
              const existingRepliers = new Set(m.replied_by.map((r) => r.email.toLowerCase()));
              const hasNewReplier =
                (replyAt !== null && m.replied_at === null) ||
                repliedByAfter.some((r) => !existingRepliers.has(r.email.toLowerCase()));

              db.markReplyChecked(m.id, replyAt, checkedAt, {
                repliedBy: repliedByAfter,
                bouncedAt,
                bounceReason,
              });
              checked++;
              if (hasNewReplier) replied++;
              if (bouncedAt !== null && m.bounced_at === null) {
                bounced++;
                opts.onBounce?.({ message: m, bouncedAt, reason: bounceReason });
              }
            }
          } else {
            const firstReplyAfterEarliest = await transport.getThreadReplyAt!(threadId, earliestSent, sender);
            for (const m of msgs) {
              const mSent = m.sent_at ?? m.created_at;
              let replyAt: number | null = null;
              if (firstReplyAfterEarliest !== null) {
                if (firstReplyAfterEarliest > mSent) {
                  replyAt = firstReplyAfterEarliest;
                } else {
                  replyAt = await transport.getThreadReplyAt!(threadId, mSent, sender);
                }
              }
              db.markReplyChecked(m.id, replyAt, checkedAt);
              checked++;
              if (replyAt !== null) replied++;
            }
          }
        } catch (err) {
          console.error(`[open-mailtrack] reply check failed for thread ${threadId}:`, err);
        }
      }
      return { checked, replied, bounced };
    } finally {
      running = false;
    }
  }

  return {
    check,
    start() {
      // Run once shortly after startup, then every intervalMs.
      const initial = setTimeout(() => void check(), 15_000);
      initial.unref?.();
      timer = setInterval(() => void check(), intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

export type ReplyChecker = ReturnType<typeof createReplyChecker>;
