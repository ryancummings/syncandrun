import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CompanionDatabase } from "../src/persistence/database.js";

it("writes setup links to a private exclusive file without logging them, and refuses an owned installation", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "syncandrun-operator-"));
  const output = join(dataDir, "invitation.txt");
  const run = () => spawnSync(process.execPath, ["--import", "tsx", "src/operator.ts", "setup-link", "--output", output], {
    encoding: "utf8",
    cwd: new URL("../", import.meta.url),
    env: { ...process.env, SYNCANDRUN_BASE_URL: "https://music.example.test", SYNCANDRUN_DATA_DIR: dataDir,
      SYNCANDRUN_SECRET: "operator-secret-with-at-least-32-bytes" }
  });
  try {
    const result = run();
    expect(result.status).toBe(0);
    const link = await readFile(output, "utf8");
    expect(link).toMatch(/^https:\/\/music\.example\.test\/#setup=[A-Za-z0-9_-]{43}\n$/);
    expect(result.stdout + result.stderr).not.toContain("#setup=");
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect(run().status).toBe(1);
    expect(await readFile(output, "utf8")).toBe(link);
    await rm(output);
    const db = new CompanionDatabase(dataDir);
    db.connection.prepare("INSERT INTO installation_owner(id, plex_user_id) VALUES (1, 'owner')").run();
    db.close();
    const rejected = run();
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("already has an owner");
    await expect(stat(output)).rejects.toThrow();
    await rm(join(dataDir, "syncandrun.sqlite"));
    await mkdir(join(dataDir, "syncandrun.sqlite"));
    expect(run().status).toBe(1);
    await expect(stat(output)).rejects.toThrow();
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
