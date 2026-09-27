import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { RuntimeConfig } from "../config.js";
import { createLogger } from "../logging.js";
import { BrowserManagementService } from "../persistence/browser-management-service.js";
import { BrowserSessionRepository } from "../persistence/browser-session-repository.js";
import type { CompanionDatabase } from "../persistence/database.js";
import { PlexLibraryService } from "../plex/library-service.js";
import { PlexSetupService } from "../plex/setup-service.js";
import { registerBrowserRoutes, type BrowserRouteDependencies } from "./browser-routes.js";
import { registerBrowserUiRoutes } from "./browser-ui.js";

/** Tests and fixtures replace only the collaborators they need to control. */
export type BrowserDependencyOverrides = Partial<BrowserRouteDependencies>;

export function buildApp(
  config: RuntimeConfig,
  database: CompanionDatabase,
  browserDependencies?: BrowserDependencyOverrides
) {
  const app = Fastify({
    genReqId: () => randomUUID().replaceAll("-", ""),
    loggerInstance: createLogger(config.logLevel),
    trustProxy: config.trustProxy
  });

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    if (!database.isReady()) return reply.code(503).send({ status: "unavailable" });
    return { status: "ok" };
  });
  registerBrowserUiRoutes(app);
  const plexSetup = browserDependencies?.plexSetup ?? new PlexSetupService(database.connection, config.secret);
  const browserSessions = browserDependencies?.browserSessions ?? new BrowserSessionRepository(database.connection, config.secret);
  registerBrowserRoutes(app, config, {
    plexSetup,
    plexLibrary: browserDependencies?.plexLibrary ?? new PlexLibraryService(database.connection, plexSetup),
    browserSessions,
    management: browserDependencies?.management ??
      new BrowserManagementService(database.connection, config.secret, browserSessions)
  });
  app.addHook("onClose", async () => database.close());
  return app;
}
