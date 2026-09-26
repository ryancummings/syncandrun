import { randomBytes } from "node:crypto";
import { constants, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const optionalString = z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional());

const environmentSchema = z.object({
  SYNCANDRUN_BASE_URL: optionalString,
  SYNCANDRUN_ARTWORK_BASE_URL: optionalString,
  SYNCANDRUN_SECRET: optionalString.refine((value) => value === undefined || Buffer.byteLength(value, "utf8") >= 32, {
    message: "must contain at least 32 bytes"
  }),
  SYNCANDRUN_DATA_DIR: z.string().min(1).default("/data"),
  SYNCANDRUN_HOST: z.string().refine((value) => isIP(value) !== 0, {
    message: "must be an IPv4 or IPv6 address"
  }).default("127.0.0.1"),
  SYNCANDRUN_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  SYNCANDRUN_LOG_LEVEL: logLevelSchema.default("info"),
  SYNCANDRUN_TRUST_PROXY: trustProxySchema
});

export interface RuntimeConfig {
  /**
   * The address browsers and watches use, when the operator pins one. Without
   * it the companion answers on whatever address a request arrived at, so a
   * home installation works on its LAN IP with no configuration.
   */
  baseUrl?: URL;
  artworkBaseUrl?: URL;
  secret: string;
  dataDir: string;
  host: string;
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

function parseBaseOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("SYNCANDRUN_BASE_URL must be an http:// or https:// origin");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== ""
      || url.search !== "" || url.hash !== "" || (url.pathname !== "" && url.pathname !== "/")) {
    throw new Error("SYNCANDRUN_BASE_URL must be an http:// or https:// origin without credentials, path, query, or fragment");
  }
  return new URL(url.origin);
}

/**
 * Reuses the secret generated on first start, or creates one. Plex credentials
 * are encrypted with it, so it lives beside the database it protects.
 */
function persistentSecret(dataDir: string): string {
  const path = resolve(dataDir, "secret");
  try {
    return readFileSync(path, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString("hex");
  try {
    writeFileSync(path, `${secret}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    // Another process created it first; use theirs.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return readFileSync(path, "utf8").trim();
    throw error;
  }
  return secret;
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
  const baseUrl = parsed.data.SYNCANDRUN_BASE_URL === undefined ? undefined : parseBaseOrigin(parsed.data.SYNCANDRUN_BASE_URL);
  const dataDir = resolve(parsed.data.SYNCANDRUN_DATA_DIR);
  return {
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(artworkBaseUrl === undefined ? {} : { artworkBaseUrl }),
    secret: parsed.data.SYNCANDRUN_SECRET ?? persistentSecret(dataDir),
    dataDir,
    host: parsed.data.SYNCANDRUN_HOST,
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
