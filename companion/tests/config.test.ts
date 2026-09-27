import { mkdtemp, rm, stat } from "node:fs/promises";
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
    expect(config.baseUrl?.href).toBe("https://music.example.test/");
    expect(config.artworkBaseUrl?.href).toBe("https://art.example.test/");
    expect(config.port).toBe(3000);
    expect(config.host).toBe("127.0.0.1");
    expect(config.logLevel).toBe("info");
    expect(config.trustProxy).toBe(false);
  });

  it.each(["127.0.0.1", "0.0.0.0", "::1", "::"])("accepts an explicit listener address %s", (host) => {
    expect(loadConfig({
      SYNCANDRUN_BASE_URL: "https://music.example.test",
      SYNCANDRUN_SECRET: "a".repeat(32),
      SYNCANDRUN_HOST: host
    }).host).toBe(host);
  });

  it.each(["", "localhost", "https://example.test", "127.0.0.1:3000"])(
    "rejects an invalid listener address %s", (host) => {
      expect(() => loadConfig({
        SYNCANDRUN_BASE_URL: "https://music.example.test",
        SYNCANDRUN_SECRET: "a".repeat(32),
        SYNCANDRUN_HOST: host
      })).toThrow("SYNCANDRUN_HOST");
    }
  );

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
    ["https://music.example.test/path", "without credentials, path"],
    ["ftp://music.example.test", "http:// or https:// origin"],
    ["not a url", "http:// or https:// origin"]
  ])("rejects an invalid base URL: %s", (baseUrl, expectedMessage) => {
    expect(() => loadConfig({ SYNCANDRUN_BASE_URL: baseUrl, SYNCANDRUN_SECRET: "a".repeat(32) })).toThrow(
      expectedMessage
    );
  });

  it.each(["http://192.168.1.20", "http://192.168.1.20:3000", "http://nas.local", "https://music.example.test:8443"])(
    "accepts an HTTP or HTTPS base URL on any host and port: %s", (origin) => {
      expect(loadConfig({ SYNCANDRUN_SECRET: "a".repeat(32), SYNCANDRUN_BASE_URL: origin }).baseUrl?.origin).toBe(origin);
    }
  );

  it("needs no configuration: the address follows each request and the secret is generated once", async () => {
    const root = await mkdtemp(join(tmpdir(), "syncandrun-config-"));
    temporaryDirectories.push(root);
    const first = loadConfig({ SYNCANDRUN_DATA_DIR: root });
    expect(first.baseUrl).toBeUndefined();
    expect(Buffer.byteLength(first.secret, "utf8")).toBeGreaterThanOrEqual(32);
    expect((await stat(join(root, "secret"))).mode & 0o777).toBe(0o600);
    expect(loadConfig({ SYNCANDRUN_DATA_DIR: root }).secret).toBe(first.secret);
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
