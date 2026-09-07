import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { createLogger, redactSensitive } from "../src/logging.js";

describe("structured log redaction", () => {
  it("recursively redacts credential keys, bearer values, and URL query credentials", () => {
    const input = {
      headers: { authorization: "Bearer device-value", cookie: "session=browser-value" },
      params: { signature: "route-capability-value" },
      nested: [{ plexToken: "plex-value", safe: "visible" }],
      transcodeUrl: "https://plex.example.test/audio?X-Plex-Token=plex-value&quality=96",
      artworkUrl:
        "/api/v1/watch/a/abcdefghijklmnopqrstuv/1786816800/zyxwvutsrqponmlkjihgfe/plex:track:100"
    };
    const serialized = JSON.stringify(redactSensitive(input));
    expect(serialized).not.toContain("device-value");
    expect(serialized).not.toContain("browser-value");
    expect(serialized).not.toContain("plex-value");
    expect(serialized).not.toContain("route-capability-value");
    expect(serialized).not.toContain("zyxwvutsrqponmlkjihgfe");
    expect(serialized).toContain("visible");
    expect(serialized).toContain("quality=96");
    expect(serialized).toContain(encodeURIComponent("[REDACTED]"));
  });

  it("handles circular structures without leaking nested secrets", () => {
    const value: Record<string, unknown> = { pairingCode: "K7M4Q2" };
    value.self = value;
    expect(redactSensitive(value)).toEqual({ pairingCode: "[REDACTED]", self: "[Circular]" });
  });

  it("redacts null-prototype request objects produced by serializers", () => {
    const request = Object.assign(Object.create(null) as Record<string, unknown>, {
      url: "/api/v1/watch/a/abcdefghijklmnopqrstuv/1786816800/zyxwvutsrqponmlkjihgfe/plex:track:100",
      params: Object.assign(Object.create(null) as Record<string, unknown>, {
        signature: "route-capability-value"
      })
    });
    const serialized = JSON.stringify(redactSensitive(request));
    expect(serialized).not.toContain("zyxwvutsrqponmlkjihgfe");
    expect(serialized).not.toContain("route-capability-value");
  });

  it("redacts serializer records with Pino-style object prototypes", () => {
    const request = Object.assign(Object.create({ id: "", method: "", url: "" }) as Record<string, unknown>, {
      url: "/api/v1/watch/a/abcdefghijklmnopqrstuv/1786816800/zyxwvutsrqponmlkjihgfe/plex:track:100",
      params: { signature: "route-capability-value" }
    });
    const serialized = JSON.stringify(redactSensitive(request));
    expect(serialized).not.toContain("zyxwvutsrqponmlkjihgfe");
    expect(serialized).not.toContain("route-capability-value");
  });

  it("applies redaction through the configured logger", () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      }
    });
    const logger = createLogger("info", destination);
    logger.info({ nested: { deviceToken: "device-value" }, event: "paired" });
    expect(JSON.parse(output)).toMatchObject({ nested: { deviceToken: "[REDACTED]" }, event: "paired" });
    expect(output).not.toContain("device-value");
  });

  it("redacts capability routes in Fastify request logs", async () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      }
    });
    const app = Fastify({ loggerInstance: createLogger("info", destination) });
    app.get("/api/v1/watch/a/:artworkId/:expires/:signature/:trackId", async () => ({ ok: true }));
    await app.inject({
      method: "GET",
      url: "/api/v1/watch/a/abcdefghijklmnopqrstuv/1786816800/zyxwvutsrqponmlkjihgfe/plex%3Atrack%3A100"
    });
    await app.close();
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("zyxwvutsrqponmlkjihgfe");
  });
});

it("redacts owner setup capabilities from request URLs, fragments and bodies", () => {
  const token = "a".repeat(43);
  const id = "a28326e1-9288-449a-a557-8286c97886d1";
  const result = JSON.stringify(redactSensitive({
    invitation: token,
    url: `/api/v1/setup/plex/pin/${id}`,
    setupUrl: `https://music.example.test/#setup=${token}`
  }));
  expect(result).not.toContain(token);
  expect(result).not.toContain(id);
});
