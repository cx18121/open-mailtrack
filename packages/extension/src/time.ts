const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/** "just now", "5 min ago", "2 hours ago", "yesterday", "3 days ago", or a date. */
export function ago(t: number, now = Date.now()): string {
  const d = now - t;
  if (d < MIN) return "just now";
  if (d < HOUR) return `${Math.round(d / MIN)} min ago`;
  if (d < DAY && sameDay(t, now)) return `${Math.round(d / HOUR)} hour${d < 1.5 * HOUR ? "" : "s"} ago`;
  if (sameDay(t, now - DAY)) return "yesterday";
  if (d < 7 * DAY) return `${Math.round(d / DAY)} days ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "3:21 PM" today, "yesterday 3:21 PM", or "Sep 12, 3:21 PM". */
export function when(t: number, now = Date.now()): string {
  if (sameDay(t, now)) return clock(t);
  if (sameDay(t, now - DAY)) return `yesterday ${clock(t)}`;
  const date = new Date(t).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: new Date(t).getFullYear() === new Date(now).getFullYear() ? undefined : "numeric",
  });
  return `${date}, ${clock(t)}`;
}

/** Day label for a list: "today", "yesterday", "Sep 12". */
export function day(t: number, now = Date.now()): string {
  if (sameDay(t, now)) return "today";
  if (sameDay(t, now - DAY)) return "yesterday";
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
