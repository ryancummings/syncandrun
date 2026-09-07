import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  randomInt,
  scrypt,
  timingSafeEqual
} from "node:crypto";

const keyLength = 32;
const nonceLength = 12;
const authTagLength = 16;
// Digits only: the watch enters this code on a six-position digit picker, so
// the alphabet has to be one that picker can produce. This trades the former
// base32 alphabet's ~30 bits for ~19.9 bits, which stays safe because a code
// dies after five failed attempts or ten minutes, whichever comes first.
const pairingAlphabet = "0123456789";
const applicationSalt = Buffer.from("syncandrun-for-garmin/v1", "utf8");
const plexTokenContext = Buffer.from("plex-token", "utf8");
const plexPinCodeContext = Buffer.from("plex-pin-code", "utf8");

function deriveKey(secret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), applicationSalt, purpose, keyLength));
}

export interface EncryptedPlexToken {
  encryptedToken: Buffer;
  nonce: Buffer;
}

export type EncryptedPlexPinCode = EncryptedPlexToken;

export function encryptPlexToken(token: string, secret: string): EncryptedPlexToken {
  const nonce = randomBytes(nonceLength);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret, "plex-token-encryption"), nonce);
  cipher.setAAD(plexTokenContext);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return { encryptedToken: Buffer.concat([ciphertext, cipher.getAuthTag()]), nonce };
}

export function decryptPlexToken(value: EncryptedPlexToken, secret: string): string {
  if (value.nonce.length !== nonceLength || value.encryptedToken.length <= authTagLength) {
    throw new Error("Invalid encrypted Plex token");
  }
  const tagOffset = value.encryptedToken.length - authTagLength;
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret, "plex-token-encryption"), value.nonce);
  decipher.setAAD(plexTokenContext);
  decipher.setAuthTag(value.encryptedToken.subarray(tagOffset));
  return Buffer.concat([
    decipher.update(value.encryptedToken.subarray(0, tagOffset)),
    decipher.final()
  ]).toString("utf8");
}

export function encryptPlexPinCode(code: string, secret: string): EncryptedPlexPinCode {
  const nonce = randomBytes(nonceLength);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret, "plex-pin-code-encryption"), nonce);
  cipher.setAAD(plexPinCodeContext);
  const ciphertext = Buffer.concat([cipher.update(code, "utf8"), cipher.final()]);
  return { encryptedToken: Buffer.concat([ciphertext, cipher.getAuthTag()]), nonce };
}

export function decryptPlexPinCode(value: EncryptedPlexPinCode, secret: string): string {
  if (value.nonce.length !== nonceLength || value.encryptedToken.length <= authTagLength) {
    throw new Error("Invalid encrypted Plex PIN code");
  }
  const tagOffset = value.encryptedToken.length - authTagLength;
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret, "plex-pin-code-encryption"), value.nonce);
  decipher.setAAD(plexPinCodeContext);
  decipher.setAuthTag(value.encryptedToken.subarray(tagOffset));
  return Buffer.concat([
    decipher.update(value.encryptedToken.subarray(0, tagOffset)),
    decipher.final()
  ]).toString("utf8");
}

export function createDeviceToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashDeviceToken(token: string, secret: string): Buffer {
  return createHmac("sha256", deriveKey(secret, "device-token-hashing")).update(token, "utf8").digest();
}

export function verifyDeviceToken(token: string, expectedHash: Buffer, secret: string): boolean {
  const actualHash = hashDeviceToken(token, secret);
  return expectedHash.length === actualHash.length && timingSafeEqual(expectedHash, actualHash);
}

export function createBrowserSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashBrowserSessionToken(token: string, secret: string): Buffer {
  return createHmac("sha256", deriveKey(secret, "browser-session-hashing")).update(token, "utf8").digest();
}

export function verifyBrowserSessionToken(token: string, expectedHash: Buffer, secret: string): boolean {
  const actualHash = hashBrowserSessionToken(token, secret);
  return expectedHash.length === actualHash.length && timingSafeEqual(expectedHash, actualHash);
}

export function createCsrfToken(sessionToken: string, secret: string): string {
  return createHmac("sha256", deriveKey(secret, "browser-csrf-token"))
    .update(sessionToken, "utf8")
    .digest("base64url");
}

export function verifyCsrfToken(value: string, sessionToken: string, secret: string): boolean {
  const expected = Buffer.from(createCsrfToken(sessionToken, secret), "utf8");
  const actual = Buffer.from(value, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function createPairingCode(): string {
  // randomInt rejection-samples, so every digit stays equally likely. Taking a
  // byte modulo ten would bias 0-5 upward, because 256 is not a multiple of 10.
  return Array.from({ length: 6 }, () => pairingAlphabet[randomInt(pairingAlphabet.length)]).join("");
}

function normalizePairingCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "");
}

export function createPairingCodeSalt(): Buffer {
  return randomBytes(16);
}

export async function hashPairingCode(code: string, salt: Buffer): Promise<Buffer> {
  const normalized = normalizePairingCode(code);
  return new Promise((resolve, reject) => {
    scrypt(normalized, salt, keyLength, { N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function verifyPairingCode(code: string, expectedHash: Buffer, salt: Buffer): Promise<boolean> {
  const normalized = normalizePairingCode(code);
  const actualHash = await hashPairingCode(normalized, salt);
  const validFormat = normalized.length === 6 && [...normalized].every((character) => pairingAlphabet.includes(character));
  return validFormat && expectedHash.length === actualHash.length && timingSafeEqual(expectedHash, actualHash);
}
