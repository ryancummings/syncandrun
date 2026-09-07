import { createRuntime } from "./runtime.js";

const { app, database, config } = await createRuntime();
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "Companion shutting down");
  try {
    await app.close();
    database.close();
  } catch (error) {
    app.log.error(error, "Companion shutdown failed");
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: "0.0.0.0", port: config.port });
} catch (error) {
  app.log.fatal(error, "Companion startup failed");
  await app.close();
  database.close();
  process.exitCode = 1;
}
