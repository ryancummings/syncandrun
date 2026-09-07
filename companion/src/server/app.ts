import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { RuntimeConfig } from "../config.js";
import { createLogger } from "../logging.js";
import { DeviceRepository } from "../persistence/device-repository.js";
import type { CompanionDatabase } from "../persistence/database.js";
import { WatchConfigurationRepository } from "../persistence/watch-configuration-repository.js";
import { WatchManifestRepository } from "../persistence/watch-manifest-repository.js";
import { BrowserSessionRepository } from "../persistence/browser-session-repository.js";
import { BrowserManagementService } from "../persistence/browser-management-service.js";
import { PlexSetupService } from "../plex/setup-service.js";
import { PlexLibraryService } from "../plex/library-service.js";
import { PlexMediaProxy } from "../plex/media-proxy.js";
import { registerBrowserRoutes, type BrowserRouteDependencies } from "./browser-routes.js";

/** Tests and fixtures replace only the collaborators they need to control. */
export type BrowserDependencyOverrides = Partial<BrowserRouteDependencies>;
import { registerBrowserUiRoutes } from "./browser-ui.js";
import { registerWatchRoutes } from "./watch-routes.js";
import { LiveSyncTracker } from "../sync/live-sync-tracker.js";
import { SyncPlanService } from "../sync/sync-plan.js";

export function buildApp(
  config: RuntimeConfig,
  database: CompanionDatabase,
  browserDependencies?: BrowserDependencyOverrides,
  watchMediaProxy?: PlexMediaProxy
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
  const liveSync = browserDependencies?.liveSync ?? new LiveSyncTracker();
  const plexSetup = browserDependencies?.plexSetup ?? new PlexSetupService(database.connection, config.secret);
  const devices = new DeviceRepository(database.connection, config.secret);
  registerWatchRoutes(
    app,
    devices,
    new WatchConfigurationRepository(database.connection),
    new WatchManifestRepository(database.connection, config.secret, config.artworkBaseUrl),
    watchMediaProxy ?? new PlexMediaProxy(database.connection, plexSetup),
    liveSync
  );
  const browserSessions = browserDependencies?.browserSessions ?? new BrowserSessionRepository(database.connection, config.secret);
  registerBrowserRoutes(app, config, {
    plexSetup,
    plexLibrary: browserDependencies?.plexLibrary ?? new PlexLibraryService(database.connection, plexSetup),
    browserSessions,
    management:
      browserDependencies?.management ??
      new BrowserManagementService(database.connection, config.secret, devices, browserSessions),
    syncPlan: browserDependencies?.syncPlan ?? new SyncPlanService(database.connection),
    liveSync
  });
  app.addHook("onClose", async () => database.close());
  return app;
}
