import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const PREFIX = "v1";
const SALT = Buffer.from("open-mailtrack-encryption-v1", "utf8");
const INFO = Buffer.from("aes-256-gcm", "utf8");

export type Cipher = {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
};

export function createCipher(secret: string): Cipher {
  if (!secret || !secret.trim()) throw new Error("encryption secret must be non-empty");
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), SALT, INFO, 32));

  return {
    encrypt(plaintext: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${PREFIX}:${iv.toString("base64url")}:${tag.toString("base64url")}:${enc.toString("base64url")}`;
    },
    decrypt(ciphertext: string): string {
      const parts = ciphertext.split(":");
      if (parts.length !== 4 || parts[0] !== PREFIX) throw new Error("invalid ciphertext format");
      const iv = Buffer.from(parts[1], "base64url");
      const tag = Buffer.from(parts[2], "base64url");
      const data = Buffer.from(parts[3], "base64url");
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    },
  };
}
