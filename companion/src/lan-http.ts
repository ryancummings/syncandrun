import { isIP } from "node:net";

/** Only RFC 1918 IPv4 addresses qualify for the explicit LAN HTTP mode. */
export function isPrivateLanHttpUrl(url: URL): boolean {
  if (url.protocol !== "http:" || url.port !== "" || isIP(url.hostname) !== 4) return false;
  const [first, second] = url.hostname.split(".").map(Number);
  return first === 10 || (first === 172 && second !== undefined && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}
