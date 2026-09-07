import { open, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, ensureWritableDataDirectory } from "./config.js";
import { CompanionDatabase } from "./persistence/database.js";
import { OwnerRepository } from "./persistence/owner-repository.js";

async function main() {
  const [command, option, output, ...extra] = process.argv.slice(2);
  if (command !== "setup-link" || option !== "--output" || !output || extra.length) {
    throw new Error("Usage: node dist/operator.js setup-link --output /private/setup-link.txt");
  }
  const config = loadConfig();
  await ensureWritableDataDirectory(config.dataDir);
  const file = await open(resolve(output), "wx", 0o600);
  let database: CompanionDatabase | undefined;
  let complete = false;
  try {
    database = new CompanionDatabase(config.dataDir);
    database.migrate();
    const token = new OwnerRepository(database.connection).issueInvitation();
    const url = new URL(config.baseUrl);
    url.hash = `setup=${token}`;
    await file.writeFile(`${url.href}\n`);
    complete = true;
    process.stdout.write("Setup link saved to the requested private file; expires in 30 minutes.\n");
  } finally {
    try {
      database?.close();
    } finally {
      await file.close();
      if (!complete) await unlink(resolve(output));
    }
  }
}
main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Operator command failed"}\n`);
  process.exitCode = 1;
});
