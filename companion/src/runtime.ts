import { ensureWritableDataDirectory, loadConfig, type RuntimeConfig } from "./config.js";
import { CompanionDatabase } from "./persistence/database.js";
import { buildApp } from "./server/app.js";

export async function createRuntime(config: RuntimeConfig = loadConfig()) {
  await ensureWritableDataDirectory(config.dataDir);
  const database = new CompanionDatabase(config.dataDir);
  try {
    database.migrate();
    database.reconcileArtworkOrigin(config.artworkBaseUrl);
    return { app: buildApp(config, database), database, config };
  } catch (error) {
    database.close();
    throw error;
  }
}
