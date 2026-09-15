import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Config = {
  serverUrl: string;
  apiKey: string;
  senderName: string;
  senderEmail: string;
  google: {
    clientId: string;
    clientSecret: string;
    refreshToken?: string;
  };
};

const dir = process.env.OPENMT_CONFIG_DIR ?? join(homedir(), ".config", "open-mailtrack");
export const configPath = join(dir, "config.json");

export function readConfig(): Config {
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    throw new Error(`No config at ${configPath}. Run \`openmt auth\` first.`);
  }
}

export function writeConfig(config: Config) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}
