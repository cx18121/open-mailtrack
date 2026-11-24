import { describe, expect, it } from "vitest";
import { AppleRelayMatcher } from "./apple-mpp.js";
import { classifyHit, describeClient, extractOpenEvents, summarize } from "./classify.js";

const PROXY = "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)";
const PREFETCH = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/42.0.2311.135 Safari/537.36 Edge/12.246 Mozilla/5.0";
const hit = (at: number) => ({ at, user_agent: PROXY });

describe("classifyHit", () => {
  it("marks the sender's own view: proxy hit 10ms before the view signal (matrix, smoke 1)", () => {
    expect(classifyHit(hit(1789499643286), [1789499643296]).kind).toBe("self_view");
  });

  it("marks a hit shortly after the view signal as self view (collapsed message expanded)", () => {
    expect(classifyHit(hit(1000 + 12_000), [1000]).kind).toBe("self_view");
  });

  it("does not attribute a hit well outside the view window to the sender", () => {
    expect(classifyHit(hit(1000 + 60_000), [1000]).kind).toBe("open");
    expect(classifyHit(hit(1000 - 30_000), [1000]).kind).toBe("open");
  });

  it("treats a recipient's proxy fetch with no view signal as an open (matrix, ext 1, +440s)", () => {
    expect(classifyHit(hit(1789500109100), [], { sentAts: [1789499669079], otherHitAts: [] }).kind).toBe("open");
  });

  it("recognises gmail's thread-wide refetch after a reply by its shape (04:23:32 and 04:33:20)", () => {
    const original = 1789499669079;
    const reply = 1789532595941;
    const scanAt = reply + 16_239;
    const thread = { sentAts: [original, reply], otherHitAts: [scanAt + 120] };
    expect(classifyHit(hit(scanAt), [], thread).kind).toBe("prefetch");
    expect(classifyHit(hit(scanAt + 120), [], { sentAts: [original, reply], otherHitAts: [scanAt] }).kind).toBe("prefetch");
  });

  it.each([
    [-1, "open"],
    [0, "prefetch"],
    [376, "prefetch"],
    [15_619, "prefetch"],
    [30_000, "prefetch"],
    [30_001, "open"],
  ] as const)("classifies a lone proxy fetch %ims after send as %s", (delta, kind) => {
    const sentAt = 1791304670944;
    expect(classifyHit(hit(sentAt + delta), [], { sentAts: [sentAt], otherHitAts: [] }).kind).toBe(kind);
  });

  it.each([12_266, 3_600_000])("excludes the known Gmail prefetch bot %ims after sending", (delta) => {
    const sentAt = 1790620079541;
    expect(classifyHit({ at: sentAt + delta, user_agent: PREFETCH }, [], { sentAts: [sentAt], otherHitAts: [] }).kind).toBe("prefetch");
  });

  it("recognises the bot without a send timestamp but not a similar browser user agent", () => {
    expect(classifyHit({ at: 1000, user_agent: PREFETCH }, []).kind).toBe("prefetch");
    expect(classifyHit({ at: 1000, user_agent: PREFETCH.replace("Chrome/42.0.2311.135", "Chrome/42.0.2311.136") }, []).kind).toBe("open");
    expect(classifyHit({ at: 1000, user_agent: null }, []).kind).toBe("open");
    expect(classifyHit(hit(1000), []).kind).toBe("open");
  });

  it("preserves self-view precedence for the known bot", () => {
    expect(classifyHit({ at: 1000, user_agent: PREFETCH }, [1000]).kind).toBe("self_view");
  });

  it("preserves the thread-wide cluster exclusion beyond 30 seconds", () => {
    const reply = 100_000;
    expect(classifyHit(hit(reply + 45_000), [], { sentAts: [0, reply], otherHitAts: [reply + 45_100] }).kind).toBe("prefetch");
  });

  it("treats a lone fetch of a reply into an existing thread as the scan (04:33:20)", () => {
    const original = 1789499669079;
    const reply = 1789533183570;
    expect(classifyHit(hit(reply + 16_531), [], { sentAts: [original, reply], otherHitAts: [] }).kind).toBe("prefetch");
    expect(classifyHit(hit(reply + 45_000), [], { sentAts: [original, reply], otherHitAts: [] }).kind).toBe("open");
  });

  it("keeps a cluster as opens when it is not close to a send", () => {
    const sentAt = 1789533183570;
    const later = sentAt + 3_600_000;
    expect(classifyHit(hit(later), [], { sentAts: [sentAt], otherHitAts: [later + 300] }).kind).toBe("open");
  });

  it("only applies the scan rule to google's proxy", () => {
    const sentAt = 1789533183570;
    expect(classifyHit({ at: sentAt + 5_000, user_agent: "Mozilla/5.0 (iPhone) Safari" }, [], { sentAts: [sentAt], otherHitAts: [sentAt + 5_100] }).kind).toBe("open");
  });

  it("classifies bare Mozilla/5.0 from Apple Private Relay IPs as apple_mpp", () => {
    const isAppleRelayIp = (ip: string | null | undefined) => ip === "172.224.224.5";
    expect(
      classifyHit({ at: 5000, ip: "172.224.224.5", user_agent: "Mozilla/5.0" }, [], undefined, { isAppleRelayIp }).kind,
    ).toBe("apple_mpp");
    // Same IP with a normal browser UA is a real open (e.g. Safari on iCloud Private Relay)
    expect(
      classifyHit({ at: 5000, ip: "172.224.224.5", user_agent: "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15" }, [], undefined, { isAppleRelayIp }).kind,
    ).toBe("open");
    // Non-Apple IP with Mozilla/5.0 is not Apple MPP
    expect(
      classifyHit({ at: 5000, ip: "1.2.3.4", user_agent: "Mozilla/5.0" }, [], undefined, { isAppleRelayIp }).kind,
    ).toBe("open");
  });

  it("excludes security scanners and link preview bots", () => {
    for (const ua of [
      "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
      "Mozilla/5.0 (compatible; Proofpoint/1.0)",
      "Mimecast Security Scanner",
      "curl/8.4.0",
      "Mozilla/5.0 HeadlessChrome/120.0.0.0",
      "Microsoft Office Existence Discovery",
    ]) {
      expect(classifyHit({ at: 5000, user_agent: ua }, []).kind, ua).toBe("bot");
    }
  });

  it("excludes hits matching configured ignored IPs and CIDRs", () => {
    const matcher = AppleRelayMatcher.fromEntries(["203.0.113.4", "198.51.100.0/24", "2001:db8::1"]);
    const opts = { isIgnoredIp: (ip: string | null | undefined) => matcher.has(ip) };
    expect(classifyHit({ at: 5000, ip: "203.0.113.4", user_agent: "Mozilla/5.0 (iPhone)" }, [], undefined, opts).kind).toBe("ignored");
    expect(classifyHit({ at: 5000, ip: "198.51.100.42", user_agent: "Mozilla/5.0 (Macintosh)" }, [], undefined, opts).kind).toBe("ignored");
    expect(classifyHit({ at: 5000, ip: "2001:db8::1", user_agent: "Mozilla/5.0 (Windows)" }, [], undefined, opts).kind).toBe("ignored");
    expect(classifyHit({ at: 5000, ip: "8.8.8.8", user_agent: "Mozilla/5.0 (iPhone)" }, [], undefined, opts).kind).toBe("open");
  });

  it("suppresses GoogleImageProxy hits after recipient reply to prevent mobile Gmail quoted-pixel self-opens", () => {
    const replyAt = 100_000;
    expect(classifyHit(hit(replyAt - 1), [], undefined, { repliedAt: replyAt }).kind).toBe("open");
    expect(classifyHit(hit(replyAt), [], undefined, { repliedAt: replyAt }).kind).toBe("post_reply");
    expect(classifyHit(hit(replyAt + 60_000), [], undefined, { repliedAt: replyAt }).kind).toBe("post_reply");
    // Direct non-Google-proxy opens after reply still count
    expect(
      classifyHit({ at: replyAt + 60_000, user_agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)" }, [], undefined, { repliedAt: replyAt }).kind,
    ).toBe("open");
  });
});

describe("describeClient and extractOpenEvents", () => {
  it("parses honest client hints and deduplicates open events", () => {
    expect(describeClient(PROXY, "open")).toBe("Gmail");
    expect(describeClient("Mozilla/5.0", "apple_mpp")).toBe("Apple Mail (privacy proxy)");
    expect(describeClient("Outlook-iOS/711.2442958", "open")).toBe("Outlook (iOS)");
    expect(describeClient("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)", "open")).toBe("iPhone");
    expect(describeClient("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "open")).toBe("macOS");

    const events = extractOpenEvents([
      { at: 1000, kind: "open", reason: "", client: "Gmail" },
      { at: 1500, kind: "open", reason: "", client: "Gmail" },
      { at: 20_000, kind: "post_reply", reason: "", client: "Gmail" },
      { at: 30_000, kind: "open", reason: "", client: "iPhone" },
    ]);
    expect(events).toEqual([
      { at: 1000, client: "Gmail" },
      { at: 30_000, client: "iPhone" },
    ]);
  });
});

describe("summarize", () => {
  it("counts sessions, not renders: matrix ext 1 had web, hard refresh, and ios opens", () => {
    const s = summarize([
      { at: 1789500109100, kind: "open", reason: "" },
      { at: 1789501353180, kind: "open", reason: "" },
      { at: 1789501524320, kind: "open", reason: "" },
    ]);
    expect(s).toEqual({
      opens: 3,
      firstOpenAt: 1789500109100,
      lastOpenAt: 1789501524320,
      openAts: [1789500109100, 1789501353180, 1789501524320],
      late: null,
      appleMpp: 0,
      firstAppleMppAt: null,
      lastAppleMppAt: null,
      appleMppAts: [],
    });
  });

  it("collapses double fetches within 10 seconds and ignores self views", () => {
    const s = summarize([
      { at: 1000, kind: "open", reason: "" },
      { at: 1800, kind: "open", reason: "" },
      { at: 50_000, kind: "self_view", reason: "" },
    ]);
    expect(s).toEqual({
      opens: 1,
      firstOpenAt: 1000,
      lastOpenAt: 1000,
      openAts: [1000],
      late: null,
      appleMpp: 0,
      firstAppleMppAt: null,
      lastAppleMppAt: null,
      appleMppAts: [],
    });
  });

  it("tracks apple_mpp fetches separately without inflating confirmed opens", () => {
    const s = summarize([
      { at: 2000, kind: "apple_mpp", reason: "" },
      { at: 2500, kind: "apple_mpp", reason: "" },
      { at: 60_000, kind: "apple_mpp", reason: "" },
    ]);
    expect(s).toEqual({
      opens: 0,
      firstOpenAt: null,
      lastOpenAt: null,
      openAts: [],
      late: null,
      appleMpp: 2,
      firstAppleMppAt: 2000,
      lastAppleMppAt: 60_000,
      appleMppAts: [2000, 60_000],
    });
  });

  it("is empty with no opens", () => {
    expect(summarize([])).toEqual({
      opens: 0,
      firstOpenAt: null,
      lastOpenAt: null,
      openAts: [],
      late: null,
      appleMpp: 0,
      firstAppleMppAt: null,
      lastAppleMppAt: null,
      appleMppAts: [],
    });
  });

  it("flags a first open long after sending and a reopen long after the previous open", () => {
    const day = 86_400_000;
    const open = (at: number) => ({ at, kind: "open" as const, reason: "" });
    expect(summarize([open(6 * day)], 0).late).toEqual({ kind: "after_send", days: 6 });
    expect(summarize([open(3600_000)], 0).late).toBeNull();
    expect(summarize([open(1 * day), open(10 * day)], 0).late).toEqual({ kind: "after_previous", days: 9 });
    expect(summarize([open(1 * day), open(1 * day + 3600_000)], 0).late).toBeNull();
  });
});
