import { constants } from "node:fs";
import { access, mkdir, open, unlink } from "node:fs/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { z } from "zod";

const logLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);
/** Subnet keywords understood by Fastify's proxy-address parser. */
const trustProxyKeywords = new Set(["loopback", "linklocal", "uniquelocal"]);

function isTrustedProxyEntry(entry: string): boolean {
  if (trustProxyKeywords.has(entry)) return true;
  const [address, prefix, ...extra] = entry.split("/");
  if (address === undefined || extra.length > 0) return false;
  const version = isIP(address);
  if (version === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (version === 4 ? 32 : 128);
}

/**
 * `true` trusts `X-Forwarded-For` from any peer, which is only safe when the
 * service cannot be reached except through the proxy. When the listener is
 * reachable directly — a LAN bind, say — name the proxy instead, so a client
 * that connects around it cannot choose its own rate-limit identity.
 */
const trustProxySchema = z
  .string()
  .default("false")
  .transform((value) => value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0))
  .refine(
    (entries) =>
      entries.length === 0 ||
      (entries.length === 1 && (entries[0] === "true" || entries[0] === "false")) ||
      entries.every(isTrustedProxyEntry),
    { message: "must be true, false, or a comma-separated list of proxy IP addresses, CIDR ranges, or subnet keywords" }
  )
  .transform((entries): boolean | string[] => {
    if (entries.length === 0 || entries[0] === "false") return false;
    if (entries[0] === "true") return true;
    return entries;
  });

const environmentSchema = z.object({
  SYNCANDRUN_BASE_URL: z.string().min(1),
  SYNCANDRUN_ARTWORK_BASE_URL: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().min(1).optional()
  ),
  SYNCANDRUN_SECRET: z.string().refine((value) => Buffer.byteLength(value, "utf8") >= 32, {
    message: "must contain at least 32 bytes"
  }),
  SYNCANDRUN_DATA_DIR: z.string().min(1).default("/data"),
  SYNCANDRUN_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  SYNCANDRUN_LOG_LEVEL: logLevelSchema.default("info"),
  SYNCANDRUN_TRUST_PROXY: trustProxySchema
});

export interface RuntimeConfig {
  baseUrl: URL;
  artworkBaseUrl?: URL;
  secret: string;
  dataDir: string;
  port: number;
  logLevel: z.infer<typeof logLevelSchema>;
  /** `true`, `false`, or the proxies whose forwarded-for header is believed. */
  trustProxy: boolean | string[];
}

function parseHttpsOrigin(value: string, variable: "SYNCANDRUN_BASE_URL" | "SYNCANDRUN_ARTWORK_BASE_URL"): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variable} must be a valid HTTPS origin`);
  }
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error(
      `${variable} must be an HTTPS origin without credentials, path, query, fragment, or a nonstandard port`
    );
  }
  return new URL(url.origin);
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid SyncAndRun configuration: ${details}`);
  }
  const artworkBaseUrl = parsed.data.SYNCANDRUN_ARTWORK_BASE_URL === undefined
    ? undefined
    : parseHttpsOrigin(parsed.data.SYNCANDRUN_ARTWORK_BASE_URL, "SYNCANDRUN_ARTWORK_BASE_URL");
  return {
    baseUrl: parseHttpsOrigin(parsed.data.SYNCANDRUN_BASE_URL, "SYNCANDRUN_BASE_URL"),
    ...(artworkBaseUrl === undefined ? {} : { artworkBaseUrl }),
    secret: parsed.data.SYNCANDRUN_SECRET,
    dataDir: resolve(parsed.data.SYNCANDRUN_DATA_DIR),
    port: parsed.data.SYNCANDRUN_PORT,
    logLevel: parsed.data.SYNCANDRUN_LOG_LEVEL,
    trustProxy: parsed.data.SYNCANDRUN_TRUST_PROXY
  };
}

export async function ensureWritableDataDirectory(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await access(dataDir, constants.R_OK | constants.W_OK);
  const probePath = resolve(dataDir, `.syncandrun-write-probe-${process.pid}`);
  const probe = await open(probePath, "wx", 0o600);
  await probe.close();
  await unlink(probePath);
}
