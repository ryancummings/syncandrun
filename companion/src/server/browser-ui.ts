import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault
} from "fastify";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const runtimeUiDirectory = resolve(moduleDirectory, "../ui");
const developmentUiDirectory = resolve(moduleDirectory, "../../dist/ui");
const uiDirectory = existsSync(runtimeUiDirectory) ? runtimeUiDirectory : developmentUiDirectory;

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8"
};

/** Fonts and licenses never change within a build; the app bundle must not be cached. */
const immutableExtensions = new Set([".woff2", ".txt"]);

function loadUiAsset(path: string): Buffer {
  try {
    return readFileSync(resolve(uiDirectory, path));
  } catch (error) {
    throw new Error(`Browser UI asset is missing: ${path}. Run the Vite build before starting the companion.`, {
      cause: error
    });
  }
}

/** Recursively lists built asset paths relative to `assets/`. */
function listAssets(directory: string, prefix = ""): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) return listAssets(join(directory, entry.name), relative);
    return entry.isFile() ? [relative] : [];
  });
}

export function registerBrowserUiRoutes<Logger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    Logger
  >
): void {
  const index = loadUiAsset("index.html");
  const securityHeaders = {
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  } as const;

  const assetsDirectory = resolve(uiDirectory, "assets");
  if (!existsSync(assetsDirectory)) {
    throw new Error("Browser UI assets are missing. Run the Vite build before starting the companion.");
  }
  // Assets are read once at boot and served from memory: the built UI is
  // immutable for the lifetime of the process, and no request path ever
  // reaches the filesystem.
  const assets = new Map(listAssets(assetsDirectory).map((path) => [path, loadUiAsset(`assets/${path}`)]));

  app.get("/", async (_request, reply) =>
    reply.headers(securityHeaders).type("text/html; charset=utf-8").send(index)
  );

  app.get<{ Params: { "*": string } }>("/assets/*", async (request, reply) => {
    const path = request.params["*"];
    const asset = assets.get(path);
    if (asset === undefined) return reply.code(404).headers(securityHeaders).type("text/plain").send("Not found");
    const extension = extname(path);
    return reply
      .headers({
        ...securityHeaders,
        "Cache-Control": immutableExtensions.has(extension)
          ? "public, max-age=31536000, immutable"
          : securityHeaders["Cache-Control"]
      })
      .type(contentTypes[extension] ?? "application/octet-stream")
      .send(asset);
  });

  app.get("/setup/plex/callback", async (_request, reply) =>
    reply
      .headers(securityHeaders)
      .type("text/html; charset=utf-8")
      .send(
        "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Plex connected</title><link rel=\"stylesheet\" href=\"/assets/app.css\"><script src=\"/assets/theme.js\"></script><main class=\"shell\"><section class=\"panel bracket-frame\"><p class=\"section-label\">Plex</p><h1 class=\"display\">Plex connected</h1><p>You can close this window and return to SyncAndRun.</p></section></main></html>"
      )
  );
  app.get("/license", async (_request, reply) =>
    reply
      .headers(securityHeaders)
      .type("text/plain; charset=utf-8")
      .send(
        "SyncAndRun for Garmin is licensed under GPL-3.0-or-later and is derived from SubMusic.\n\n" +
          "Source license: https://www.gnu.org/licenses/gpl-3.0.txt\n" +
          "Upstream project: https://github.com/memen45/SubMusic\n\n" +
          "Bundled fonts are licensed under the SIL Open Font License 1.1:\n" +
          "Archivo — /assets/fonts/LICENSE-Archivo.txt\n" +
          "IBM Plex Sans and IBM Plex Mono — /assets/fonts/LICENSE-IBM-Plex.txt\n"
      )
  );
}
