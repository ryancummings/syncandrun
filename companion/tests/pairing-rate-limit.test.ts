import { describe, expect, it } from "vitest";
import { PairingRateLimit } from "../src/server/pairing-rate-limit.js";

describe("pairing rate limit", () => {
  it("bounds distinct clients and admits new ones after their windows expire", () => {
    const limiter = new PairingRateLimit();
    for (let index = 0; index < 10_000; index += 1) {
      expect(limiter.allows(`client-${index}`, 0)).toBe(true);
    }

    expect(limiter.allows("new-client", 1)).toBe(false);
    expect(limiter.allows("client-0", 1)).toBe(true);
    expect(limiter.allows("new-client", 60_000)).toBe(true);
  });
});
