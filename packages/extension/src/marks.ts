import type { OpenSummary } from "./api.js";

const when = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function describe(s: OpenSummary): string {
  if (s.opens === 0) return "Not opened yet";
  const first = `first ${when(s.firstOpenAt!)}`;
  return s.opens === 1 ? `Opened once, ${first}` : `Opened ${s.opens} times, ${first}, last ${when(s.lastOpenAt!)}`;
}

export function label(s: OpenSummary) {
  const opened = s.opens > 0;
  return {
    title: opened ? `✓✓ ${s.opens}` : "✓",
    foregroundColor: opened ? "#0b6b2e" : "#5f6368",
    backgroundColor: opened ? "#d7f2e0" : "#f1f3f4",
  };
}

export function icon(s: OpenSummary) {
  const opened = s.opens > 0;
  return {
    iconHtml: `<span style="font-weight:600;color:${opened ? "#0b6b2e" : "#5f6368"}">${opened ? "✓✓" : "✓"}</span>`,
    tooltip: describe(s),
  };
}
