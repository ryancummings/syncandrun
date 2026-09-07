import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";

const redacted = "[REDACTED]";
const sensitiveKey = /^(authorization|proxy-authorization|cookie|set-cookie|.*token|.*secret|pairingcode|invitation|pin|signature)$/i;
const sensitiveQueryKey = /^(authorization|auth|code|key|pin|signature|token|x-plex-token)$/i;

function redactString(value: string): string {
  let result = value.replace(/(\/api\/v1\/setup\/plex\/pin\/)[a-f0-9-]{36}/gi, `$1${redacted}`).replace(/(#setup=)[A-Za-z0-9_-]+/g, `$1${redacted}`);
  result = result.replace(/\bBearer\s+[^\s,;]+/gi, `Bearer ${redacted}`);
  result = result.replace(
    /(\/api\/v1\/watch\/a\/[A-Za-z0-9_-]{22}\/\d{10}\/)\w[\w-]{21}(?=\/)/g,
    `$1${redacted}`
  );
  try {
    const url = new URL(result);
    let changed = false;
    for (const key of url.searchParams.keys()) {
      if (sensitiveQueryKey.test(key)) {
        url.searchParams.set(key, redacted);
        changed = true;
      }
    }
    if (changed) result = url.toString();
  } catch {
    // Most log strings are not URLs.
  }
  return result;
}

export function redactSensitive(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  if (value instanceof Error) {
    return {
      type: value.name,
      message: redactString(value.message),
      stack: value.stack === undefined ? undefined : redactString(value.stack)
    };
  }
  const prototype = Object.getPrototypeOf(value);
  const plainRecord = prototype === Object.prototype || prototype === null || value.constructor === Object;
  if (!plainRecord && !Array.isArray(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    const target: unknown[] = [];
    seen.set(value, target);
    for (const item of value) target.push(redactSensitive(item, seen));
    return target;
  }
  const target: Record<string, unknown> = {};
  seen.set(value, target);
  for (const [key, item] of Object.entries(value)) {
    target[key] = sensitiveKey.test(key) ? redacted : redactSensitive(item, seen);
  }
  return target;
}

export function createLogger(level: LoggerOptions["level"] = "info", destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      serializers: {
        req(request) {
          const serialized = pino.stdSerializers.req(request);
          return {
            id: serialized.id,
            method: serialized.method,
            url: typeof serialized.url === "string" ? redactString(serialized.url) : serialized.url,
            query: redactSensitive(serialized.query),
            remoteAddress: serialized.remoteAddress,
            remotePort: serialized.remotePort
          };
        }
      },
      hooks: {
        logMethod(arguments_, method) {
          method.apply(this, arguments_.map((argument) => redactSensitive(argument)) as Parameters<typeof method>);
        }
      }
    },
    destination
  );
}
