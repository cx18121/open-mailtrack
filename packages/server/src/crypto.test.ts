import { describe, expect, it } from "vitest";
import { createCipher } from "./crypto.js";

describe("crypto", () => {
  it("encrypts and decrypts with authenticated AES-256-GCM", () => {
    const cipher = createCipher("super-secret-key");
    const a = cipher.encrypt("hello world");
    const b = cipher.encrypt("hello world");
    expect(a).not.toBe(b); // random IV
    expect(cipher.decrypt(a)).toBe("hello world");
    expect(cipher.decrypt(b)).toBe("hello world");
  });

  it("rejects tampered ciphertext or wrong key", () => {
    const c1 = createCipher("key-one");
    const c2 = createCipher("key-two");
    const enc = c1.encrypt("refresh-token");
    expect(() => c2.decrypt(enc)).toThrow();
    const parts = enc.split(":");
    parts[3] = `${parts[3]}A`;
    expect(() => c1.decrypt(parts.join(":"))).toThrow();
  });

  it("rejects empty secret", () => {
    expect(() => createCipher("")).toThrow();
    expect(() => createCipher("   ")).toThrow();
  });
});
