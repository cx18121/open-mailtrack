import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";

export const APPLE_RELAY_CSV_URL = "https://mask-api.icloud.com/egress-ip-ranges.csv";
const DEFAULT_MIN_ENTRIES = 10_000;
const DEFAULT_REFRESH_MS = 24 * 3_600_000;

function parseIpv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value * 256) + n;
  }
  return value >>> 0;
}

function parseIpv6(raw: string): bigint | null {
  let ip = raw.trim().toLowerCase();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);

  // Handle IPv4-embedded suffix (e.g. ::ffff:192.0.2.128)
  const lastColon = ip.lastIndexOf(":");
  if (lastColon !== -1 && ip.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4(ip.slice(lastColon + 1));
    if (v4 === null) return null;
    const hi = (v4 >>> 16).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    ip = `${ip.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - (left.length + right.length);
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;

  const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  return value;
}

function mergeV4(ranges: [number, number][]): Uint32Array {
  if (ranges.length === 0) return new Uint32Array(0);
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: number[] = [];
  let [start, end] = ranges[0];
  for (let i = 1; i < ranges.length; i++) {
    const [s, e] = ranges[i];
    if (s <= end + 1) {
      if (e > end) end = e;
    } else {
      out.push(start, end);
      start = s;
      end = e;
    }
  }
  out.push(start, end);
  return Uint32Array.from(out);
}

function mergeV6(ranges: [bigint, bigint][]): [bigint, bigint][] {
  if (ranges.length === 0) return [];
  ranges.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const out: [bigint, bigint][] = [];
  let [start, end] = ranges[0];
  for (let i = 1; i < ranges.length; i++) {
    const [s, e] = ranges[i];
    if (s <= end + 1n) {
      if (e > end) end = e;
    } else {
      out.push([start, end]);
      start = s;
      end = e;
    }
  }
  out.push([start, end]);
  return out;
}

export class AppleRelayMatcher {
  readonly v4: Uint32Array;
  readonly v6: [bigint, bigint][];
  readonly rawEntries: number;

  constructor(v4: Uint32Array, v6: [bigint, bigint][], rawEntries: number) {
    this.v4 = v4;
    this.v6 = v6;
    this.rawEntries = rawEntries;
  }

  static empty(): AppleRelayMatcher {
    return new AppleRelayMatcher(new Uint32Array(0), [], 0);
  }

  static fromCsv(csv: string): AppleRelayMatcher {
    const v4Ranges: [number, number][] = [];
    const v6Ranges: [bigint, bigint][] = [];
    let rawEntries = 0;

    for (const line of csv.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const comma = trimmed.indexOf(",");
      const cidr = (comma === -1 ? trimmed : trimmed.slice(0, comma)).trim();
      const slash = cidr.indexOf("/");
      if (slash === -1) continue;
      const host = cidr.slice(0, slash);
      const prefixStr = cidr.slice(slash + 1);
      if (!/^\d+$/.test(prefixStr)) continue;
      const prefix = Number(prefixStr);
      if (!Number.isInteger(prefix) || prefix < 0) continue;

      const version = isIP(host);
      if (version === 4 && prefix <= 32) {
        const ip = parseIpv4(host);
        if (ip === null) continue;
        const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
        const start = (ip & mask) >>> 0;
        const end = (start | (~mask >>> 0)) >>> 0;
        v4Ranges.push([start, end]);
        rawEntries++;
      } else if (version === 6 && prefix <= 128) {
        const ip = parseIpv6(host);
        if (ip === null) continue;
        const hostBits = BigInt(128 - prefix);
        const mask = hostBits === 128n ? 0n : ((1n << 128n) - 1n) ^ ((1n << hostBits) - 1n);
        const start = ip & mask;
        const end = start | ((1n << hostBits) - 1n);
        v6Ranges.push([start, end]);
        rawEntries++;
      }
    }

    return new AppleRelayMatcher(mergeV4(v4Ranges), mergeV6(v6Ranges), rawEntries);
  }

  has(rawIp: string | null | undefined): boolean {
    if (!rawIp) return false;
    let ip = rawIp.trim();
    if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
    // Normalize IPv4-mapped IPv6 (e.g. ::ffff:172.224.224.1) to IPv4 so v4 table matches too.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) ip = mapped[1];

    const version = isIP(ip);
    if (version === 4) {
      const target = parseIpv4(ip);
      if (target === null || this.v4.length === 0) return false;
      let lo = 0;
      let hi = (this.v4.length >>> 1) - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const start = this.v4[mid * 2];
        const end = this.v4[mid * 2 + 1];
        if (target < start) hi = mid - 1;
        else if (target > end) lo = mid + 1;
        else return true;
      }
      return false;
    }

    if (version === 6) {
      const target = parseIpv6(ip);
      if (target === null) return false;
      // Normalize hex-form IPv4-mapped IPv6 (e.g. ::ffff:acc0:e001) to IPv4 as well.
      if ((target >> 32n) === 0xffffn) {
        const v4 = Number(target & 0xffffffffn) >>> 0;
        const dotted = `${(v4 >>> 24) & 255}.${(v4 >>> 16) & 255}.${(v4 >>> 8) & 255}.${v4 & 255}`;
        if (this.has(dotted)) return true;
      }
      if (this.v6.length === 0) return false;
      let lo = 0;
      let hi = this.v6.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const [start, end] = this.v6[mid];
        if (target < start) hi = mid - 1;
        else if (target > end) lo = mid + 1;
        else return true;
      }
      return false;
    }

    return false;
  }
}

export type AppleRelayStoreOptions = {
  cachePath?: string;
  url?: string;
  minEntries?: number;
  refreshMs?: number;
  fetchImpl?: typeof fetch;
};

export function createAppleRelayStore(opts: AppleRelayStoreOptions = {}) {
  const url = opts.url ?? APPLE_RELAY_CSV_URL;
  const minEntries = opts.minEntries ?? DEFAULT_MIN_ENTRIES;
  const refreshMs = opts.refreshMs ?? DEFAULT_REFRESH_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;

  let matcher = AppleRelayMatcher.empty();
  let lastRefreshedAt: number | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  if (opts.cachePath && existsSync(opts.cachePath)) {
    try {
      const cached = AppleRelayMatcher.fromCsv(readFileSync(opts.cachePath, "utf8"));
      if (cached.rawEntries > 0) matcher = cached;
    } catch {
      // Fail safe to empty matcher until refresh succeeds.
    }
  }

  async function refresh(): Promise<boolean> {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) return false;
      const csv = await res.text();
      const next = AppleRelayMatcher.fromCsv(csv);
      if (next.rawEntries < minEntries) return false;
      matcher = next;
      lastRefreshedAt = Date.now();
      if (opts.cachePath) {
        const tmp = `${opts.cachePath}.tmp.${process.pid}`;
        writeFileSync(tmp, csv, "utf8");
        renameSync(tmp, opts.cachePath);
      }
      return true;
    } catch {
      return false;
    }
  }

  return {
    has: (ip: string | null | undefined) => matcher.has(ip),
    entries: () => matcher.rawEntries,
    lastRefreshedAt: () => lastRefreshedAt,
    setMatcher: (next: AppleRelayMatcher) => {
      matcher = next;
    },
    refresh,
    startBackgroundRefresh() {
      void refresh();
      timer = setInterval(() => void refresh(), refreshMs);
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

export type AppleRelayStore = ReturnType<typeof createAppleRelayStore>;
