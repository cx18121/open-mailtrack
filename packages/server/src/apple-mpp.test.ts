import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppleRelayMatcher, createAppleRelayStore } from "./apple-mpp.js";

const SAMPLE_CSV = [
  "172.224.224.0/27,US,US-CA,San Jose,",
  "172.224.224.32/27,US,US-CA,San Jose,",
  "104.28.42.0/24,US,US-NY,New York,",
  "2a09:bac0:100::/48,US,US-CA,San Jose,",
  "2a09:bac0:101::/48,US,US-CA,San Jose,",
].join("\n");

describe("AppleRelayMatcher", () => {
  it("matches IPv4, IPv4-mapped IPv6, and IPv6 ranges and merges adjacent CIDRs", () => {
    const matcher = AppleRelayMatcher.fromCsv(SAMPLE_CSV);
    expect(matcher.rawEntries).toBe(5);
    // 172.224.224.0/27 and .32/27 merge into one contiguous range
    expect(matcher.v4.length).toBe(4); // 2 ranges * 2 uint32s
    expect(matcher.v6.length).toBe(1); // 2 adjacent /48s merge

    expect(matcher.has("172.224.224.0")).toBe(true);
    expect(matcher.has("172.224.224.63")).toBe(true);
    expect(matcher.has("172.224.224.64")).toBe(false);
    expect(matcher.has("::ffff:104.28.42.19")).toBe(true);
    expect(matcher.has("::ffff:ac00:0001")).toBe(false);
    expect(matcher.has("::ffff:ace0:e005")).toBe(true); // 172.224.224.5 in hex IPv4-mapped form
    expect(matcher.has("104.28.43.1")).toBe(false);
    expect(matcher.has("2a09:bac0:100::1")).toBe(true);
    expect(matcher.has("2a09:bac0:101:ffff::1")).toBe(true);
    expect(matcher.has("2a09:bac0:102::1")).toBe(false);
    expect(matcher.has(null)).toBe(false);
    expect(matcher.has("not-an-ip")).toBe(false);

    // Malformed blank prefix must never parse as /0 matching all IPv4 addresses.
    const malformed = AppleRelayMatcher.fromCsv("1.2.3.4/,US,,,\n10.0.0.0/24,US,,,");
    expect(malformed.has("8.8.8.8")).toBe(false);
    expect(malformed.has("10.0.0.1")).toBe(true);
  });

  it("caches refreshed CSV on disk and refuses suspiciously small responses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omt-mpp-"));
    const cachePath = join(dir, "apple.csv");
    try {
      const store = createAppleRelayStore({
        cachePath,
        minEntries: 3,
        fetchImpl: async () => new Response(SAMPLE_CSV, { status: 200 }),
      });
      expect(await store.refresh()).toBe(true);
      expect(store.has("172.224.224.5")).toBe(true);
      expect(readFileSync(cachePath, "utf8")).toContain("172.224.224.0/27");

      // A tiny/broken refresh must NOT wipe the working matcher.
      const broken = createAppleRelayStore({
        cachePath,
        minEntries: 3,
        fetchImpl: async () => new Response("1.2.3.0/24,US,,,", { status: 200 }),
      });
      expect(broken.has("172.224.224.5")).toBe(true); // loaded from disk cache
      expect(await broken.refresh()).toBe(false);
      expect(broken.has("172.224.224.5")).toBe(true); // preserved
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
