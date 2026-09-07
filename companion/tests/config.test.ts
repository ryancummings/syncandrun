import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureWritableDataDirectory, loadConfig } from "../src/config.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("runtime configuration", () => {
  it("loads validated values and defaults", () => {
    const config = loadConfig({
      SYNCANDRUN_BASE_URL: "https://music.example.test",
      SYNCANDRUN_ARTWORK_BASE_URL: "https://art.example.test",
      SYNCANDRUN_SECRET: "a".repeat(32),
      SYNCANDRUN_DATA_DIR: "./data-test"
    });
    expect(config.baseUrl.href).toBe("https://music.example.test/");
    expect(config.artworkBaseUrl?.href).toBe("https://art.example.test/");
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe("info");
    expect(config.trustProxy).toBe(false);
  });

  it.each([
    ["true", true],
    ["false", false],
    ["10.4.13.42", ["10.4.13.42"]],
    ["10.4.13.42, 192.168.0.0/16", ["10.4.13.42", "192.168.0.0/16"]],
    ["loopback", ["loopback"]],
    ["fd00::1/64", ["fd00::1/64"]]
  ])("accepts trusted-proxy setting %s", (value, expected) => {
    const config = loadConfig({
      SYNCANDRUN_BASE_URL: "https://music.example.test",
      SYNCANDRUN_SECRET: "a".repeat(32),
      SYNCANDRUN_TRUST_PROXY: value as string
    });
    expect(config.trustProxy).toEqual(expected);
  });

  it.each(["yes", "10.4.13.999", "10.4.13.42/33", "true,10.4.13.42", "10.4.13.42/", "example.test"])(
    "rejects an unusable trusted-proxy setting: %s",
    (value) => {
      expect(() => loadConfig({
        SYNCANDRUN_BASE_URL: "https://music.example.test",
        SYNCANDRUN_SECRET: "a".repeat(32),
        SYNCANDRUN_TRUST_PROXY: value
      })).toThrow(/SYNCANDRUN_TRUST_PROXY/);
    }
  );

  it.each([undefined, ""])("keeps compatible single-origin artwork behavior for %s", (artworkBaseUrl) => {
    const config = loadConfig({
      SYNCANDRUN_BASE_URL: "https://music.example.test",
      SYNCANDRUN_ARTWORK_BASE_URL: artworkBaseUrl,
      SYNCANDRUN_SECRET: "a".repeat(32)
    });
    expect(config.artworkBaseUrl).toBeUndefined();
  });

  it.each(["http://art.example.test", "https://art.example.test/path", "https://art.example.test:8443"])(
    "rejects an invalid artwork base URL: %s",
    (artworkBaseUrl) => {
      expect(() => loadConfig({
        SYNCANDRUN_BASE_URL: "https://music.example.test",
        SYNCANDRUN_ARTWORK_BASE_URL: artworkBaseUrl,
        SYNCANDRUN_SECRET: "a".repeat(32)
      })).toThrow("SYNCANDRUN_ARTWORK_BASE_URL");
    }
  );

  it.each([
    ["http://music.example.test", "HTTPS origin"],
    ["https://music.example.test/path", "without credentials, path"],
    ["https://music.example.test:8443", "nonstandard port"],
    ["not a url", "valid HTTPS origin"]
  ])("rejects an invalid base URL: %s", (baseUrl, expectedMessage) => {
    expect(() => loadConfig({ SYNCANDRUN_BASE_URL: baseUrl, SYNCANDRUN_SECRET: "a".repeat(32) })).toThrow(
      expectedMessage
    );
  });

  it("rejects weak secrets without echoing them", () => {
    const weakSecret = "do-not-repeat-this";
    let thrown: unknown;
    try {
      loadConfig({ SYNCANDRUN_BASE_URL: "https://music.example.test", SYNCANDRUN_SECRET: weakSecret });
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).toContain("at least 32 bytes");
    expect(String(thrown)).not.toContain(weakSecret);
  });

  it("creates and verifies a writable data directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "syncandrun-config-"));
    temporaryDirectories.push(root);
    await expect(ensureWritableDataDirectory(join(root, "nested"))).resolves.toBeUndefined();
  });
});
