import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type RuntimeConfig } from "../src/config.js";
import { CompanionDatabase } from "../src/persistence/database.js";
import { buildApp } from "../src/server/app.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("browser UI", () => {
  it("serves a responsive, policy-restricted application shell and valid JavaScript", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "syncandrun-browser-ui-"));
    directories.push(dataDir);
    const config: RuntimeConfig = {
      baseUrl: new URL("https://music.example.test"),
      secret: "operator-secret-with-at-least-32-bytes",
      dataDir,
      port: 3000,
      logLevel: "silent",
      trustProxy: false
    };
    const database = new CompanionDatabase(dataDir);
    database.migrate();
    const app = buildApp(config, database);
    const page = await app.inject({ method: "GET", url: "/" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<meta name="viewport"');
    expect(page.body).toContain('id="root"');
    expect(page.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(page.headers["content-security-policy"]).toContain("font-src 'self'");
    expect(page.headers["cache-control"]).toBe("no-store");
    const stylesheet = await app.inject({ method: "GET", url: "/assets/app.css" });
    expect(stylesheet.body).toMatch(/@media \((?:max-width: ?640px|width<=640px)\)/);
    expect(stylesheet.headers["cache-control"]).toBe("no-store");
    const javascript = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(javascript.statusCode).toBe(200);
    expect(javascript.body).toContain("createRoot");
    expect(javascript.body).toContain("Skip to content");

    // The theme is applied before first paint by a same-origin script, because
    // the policy forbids inline script.
    const theme = await app.inject({ method: "GET", url: "/assets/theme.js" });
    expect(theme.statusCode).toBe(200);
    expect(page.body).toContain('src="/assets/theme.js"');

    const font = await app.inject({ method: "GET", url: "/assets/fonts/ibm-plex-mono-400-latin.woff2" });
    expect(font.statusCode).toBe(200);
    expect(font.headers["content-type"]).toBe("font/woff2");
    expect(font.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

    const traversal = await app.inject({ method: "GET", url: "/assets/nope.css" });
    expect(traversal.statusCode).toBe(404);
    await app.close();
  });
});
