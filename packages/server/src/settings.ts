import { AppleRelayMatcher } from "./apple-mpp.js";
import type { Cipher } from "./crypto.js";
import type { Db } from "./db.js";

export type ServerSettings = {
  discordWebhookUrl: string;
  notifyFirstOpen: boolean;
  notifyHotSpike: boolean;
  notifyRevival: boolean;
  notifyBounce: boolean;
  digestEnabled: boolean;
  digestHour: number;
  digestTimezone: string;
  ignoredIps: string[];
};

export type PublicServerSettings = Omit<ServerSettings, "discordWebhookUrl"> & {
  discordWebhookConfigured: boolean;
  discordWebhookMasked: string | null;
};

export type ServerSettingsPatch = Partial<ServerSettings>;

export type ServerSettingsEnvDefaults = {
  discordWebhookUrl?: string;
  ignoredIps?: string[];
  digestHour?: number;
  digestTimezone?: string;
};

const DISCORD_WEBHOOK_RE = /^https:\/\/(?:(?:ptb|canary)\.)?(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+(?:\?.*)?$/;

export function isValidDiscordWebhookUrl(url: string): boolean {
  return DISCORD_WEBHOOK_RE.test(url.trim());
}

export function maskWebhookUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    const parts = u.pathname.split("/").filter(Boolean);
    const tail = parts.at(-1) ?? "";
    const shownTail = tail.length > 6 ? `…${tail.slice(-6)}` : "…";
    const id = parts.at(-2) ?? "";
    return `${u.origin}/api/webhooks/${id}/${shownTail}`;
  } catch {
    return "configured";
  }
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function defaultTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && isValidTimeZone(tz)) return tz;
  } catch {
    // ignore
  }
  return "UTC";
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return fallback;
}

function parseIntInRange(raw: string | undefined, min: number, max: number, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

function normalizeIpList(ips: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ips) {
    const v = raw.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

export function parseIpListEnv(raw: string | undefined): string[] {
  if (!raw) return [];
  return normalizeIpList(raw.split(/[\s,]+/));
}

export function createSettingsStore(db: Db, cipher: Cipher, defaults: ServerSettingsEnvDefaults = {}) {
  let cachedSettings: ServerSettings | null = null;
  let cachedIpMatcher: AppleRelayMatcher | null = null;

  function loadFresh(): ServerSettings {
    const raw = db.listSettings();
    let discordWebhookUrl = defaults.discordWebhookUrl?.trim() ?? "";
    if (raw.discord_webhook_enc !== undefined) {
      if (raw.discord_webhook_enc === "") {
        discordWebhookUrl = "";
      } else {
        try {
          discordWebhookUrl = cipher.decrypt(raw.discord_webhook_enc).trim();
        } catch {
          discordWebhookUrl = "";
        }
      }
    }

    let ignoredIps = normalizeIpList(defaults.ignoredIps ?? []);
    if (raw.ignored_ips !== undefined) {
      try {
        const parsed = JSON.parse(raw.ignored_ips);
        if (Array.isArray(parsed)) ignoredIps = normalizeIpList(parsed.filter((x): x is string => typeof x === "string"));
      } catch {
        // fallback to env default
      }
    }

    const fallbackTz = defaults.digestTimezone && isValidTimeZone(defaults.digestTimezone)
      ? defaults.digestTimezone
      : defaultTimeZone();
    const digestTimezone = raw.digest_timezone && isValidTimeZone(raw.digest_timezone) ? raw.digest_timezone : fallbackTz;
    const defaultDigestEnabled = defaults.digestHour !== undefined;
    const fallbackHour = defaults.digestHour !== undefined && Number.isInteger(defaults.digestHour) && defaults.digestHour >= 0 && defaults.digestHour <= 23
      ? defaults.digestHour
      : 9;

    return {
      discordWebhookUrl,
      notifyFirstOpen: parseBool(raw.notify_first_open, true),
      notifyHotSpike: parseBool(raw.notify_hot_spike, true),
      notifyRevival: parseBool(raw.notify_revival, true),
      notifyBounce: parseBool(raw.notify_bounce, true),
      digestEnabled: parseBool(raw.digest_enabled, defaultDigestEnabled),
      digestHour: parseIntInRange(raw.digest_hour, 0, 23, fallbackHour),
      digestTimezone,
      ignoredIps,
    };
  }

  function load(): ServerSettings {
    if (!cachedSettings) {
      cachedSettings = loadFresh();
      cachedIpMatcher = null;
    }
    return cachedSettings;
  }

  function invalidateCache() {
    cachedSettings = null;
    cachedIpMatcher = null;
  }

  function getPublic(): PublicServerSettings {
    const s = load();
    const { discordWebhookUrl, ...rest } = s;
    return {
      ...rest,
      discordWebhookConfigured: Boolean(discordWebhookUrl),
      discordWebhookMasked: maskWebhookUrl(discordWebhookUrl),
    };
  }

  function update(patch: ServerSettingsPatch): PublicServerSettings {
    if (patch.discordWebhookUrl !== undefined) {
      const url = patch.discordWebhookUrl.trim();
      if (url !== "" && !isValidDiscordWebhookUrl(url)) {
        throw new Error("Discord webhook URL must be a valid https://discord.com/api/webhooks/... URL");
      }
      db.setSetting("discord_webhook_enc", url ? cipher.encrypt(url) : "");
    }
    if (patch.notifyFirstOpen !== undefined) db.setSetting("notify_first_open", String(Boolean(patch.notifyFirstOpen)));
    if (patch.notifyHotSpike !== undefined) db.setSetting("notify_hot_spike", String(Boolean(patch.notifyHotSpike)));
    if (patch.notifyRevival !== undefined) db.setSetting("notify_revival", String(Boolean(patch.notifyRevival)));
    if (patch.notifyBounce !== undefined) db.setSetting("notify_bounce", String(Boolean(patch.notifyBounce)));
    if (patch.digestEnabled !== undefined) db.setSetting("digest_enabled", String(Boolean(patch.digestEnabled)));
    if (patch.digestHour !== undefined) {
      if (!Number.isInteger(patch.digestHour) || patch.digestHour < 0 || patch.digestHour > 23) {
        throw new Error("digestHour must be an integer from 0 to 23");
      }
      db.setSetting("digest_hour", String(patch.digestHour));
    }
    if (patch.digestTimezone !== undefined) {
      const tz = patch.digestTimezone.trim();
      if (!tz || !isValidTimeZone(tz)) {
        throw new Error(`Invalid timezone: ${tz}`);
      }
      db.setSetting("digest_timezone", tz);
    }
    if (patch.ignoredIps !== undefined) {
      const normalized = normalizeIpList(patch.ignoredIps);
      db.setSetting("ignored_ips", JSON.stringify(normalized));
    }
    invalidateCache();
    return getPublic();
  }

  function isIgnoredIp(ip: string | null | undefined): boolean {
    if (!ip) return false;
    const s = load();
    if (s.ignoredIps.length === 0) return false;
    if (!cachedIpMatcher) {
      cachedIpMatcher = AppleRelayMatcher.fromEntries(s.ignoredIps);
    }
    return cachedIpMatcher.has(ip);
  }

  return {
    load,
    getPublic,
    update,
    isIgnoredIp,
  };
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;
