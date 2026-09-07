import { describe, expect, it } from "vitest";
import {
  createDeviceToken,
  createBrowserSessionToken,
  createCsrfToken,
  createPairingCode,
  createPairingCodeSalt,
  decryptPlexPinCode,
  decryptPlexToken,
  encryptPlexPinCode,
  encryptPlexToken,
  hashDeviceToken,
  hashBrowserSessionToken,
  hashPairingCode,
  verifyDeviceToken,
  verifyBrowserSessionToken,
  verifyCsrfToken,
  verifyPairingCode
} from "../src/security/credentials.js";

const secret = "operator-secret-with-at-least-32-bytes";

describe("Plex token encryption", () => {
  it("round trips through authenticated encryption without embedding plaintext", () => {
    const token = "sanitized-plex-token-value";
    const encrypted = encryptPlexToken(token, secret);
    expect(encrypted.encryptedToken.toString("utf8")).not.toContain(token);
    expect(encrypted.nonce).toHaveLength(12);
    expect(decryptPlexToken(encrypted, secret)).toBe(token);
  });

  it("rejects a changed ciphertext or operator secret", () => {
    const encrypted = encryptPlexToken("sanitized-plex-token-value", secret);
    encrypted.encryptedToken[0] = encrypted.encryptedToken[0]! ^ 1;
    expect(() => decryptPlexToken(encrypted, secret)).toThrow();
    const fresh = encryptPlexToken("sanitized-plex-token-value", secret);
    expect(() => decryptPlexToken(fresh, "different-operator-secret-at-least-32")).toThrow();
  });
});

describe("Plex PIN code encryption", () => {
  it("uses a separate authenticated-encryption context", () => {
    const encrypted = encryptPlexPinCode("sanitized-pin-code", secret);
    expect(decryptPlexPinCode(encrypted, secret)).toBe("sanitized-pin-code");
    expect(() => decryptPlexToken(encrypted, secret)).toThrow();
  });
});

describe("device credentials", () => {
  it("generates 256-bit URL-safe tokens and stores only keyed hashes", () => {
    const token = createDeviceToken();
    const hash = hashDeviceToken(token, secret);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash.toString("utf8")).not.toContain(token);
    expect(verifyDeviceToken(token, hash, secret)).toBe(true);
    expect(verifyDeviceToken(`${token}x`, hash, secret)).toBe(false);
  });
});

describe("browser credentials", () => {
  it("uses independent hashes and a session-bound CSRF token", () => {
    const token = createBrowserSessionToken();
    const hash = hashBrowserSessionToken(token, secret);
    const csrf = createCsrfToken(token, secret);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifyBrowserSessionToken(token, hash, secret)).toBe(true);
    expect(verifyBrowserSessionToken(`${token}x`, hash, secret)).toBe(false);
    expect(verifyCsrfToken(csrf, token, secret)).toBe(true);
    expect(verifyCsrfToken(`${csrf}x`, token, secret)).toBe(false);
    expect(hashDeviceToken(token, secret)).not.toEqual(hash);
  });
});

describe("pairing codes", () => {
  it("generates six digits so the watch digit picker can enter them", () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      expect(createPairingCode()).toMatch(/^[0-9]{6}$/);
    }
  });

  it("can produce every digit in every position", () => {
    const seen = Array.from({ length: 6 }, () => new Set<string>());
    for (let attempt = 0; attempt < 2000; attempt += 1) {
      const code = createPairingCode();
      seen.forEach((digits, index) => digits.add(code.charAt(index)));
    }
    // 0 and 1 were absent from the old base32 alphabet; the picker emits them.
    seen.forEach((digits) => expect(digits.size).toBe(10));
  });

  it("uses a salted slow hash and accepts human formatting", async () => {
    const code = createPairingCode();
    const salt = createPairingCodeSalt();
    const hash = await hashPairingCode(code, salt);
    expect(hash).toHaveLength(32);
    expect(await verifyPairingCode(`${code.slice(0, 3)}-${code.slice(3).toLowerCase()}`, hash, salt)).toBe(true);
    expect(await verifyPairingCode("ZZZZZZ", hash, salt)).toBe(false);
    expect(await verifyPairingCode("A7K3M9", hash, salt)).toBe(false);
    expect(await verifyPairingCode("not-valid", hash, salt)).toBe(false);
  });
});
