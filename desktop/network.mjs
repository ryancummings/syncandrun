import http from "node:http";
import { networkInterfaces } from "node:os";

export function privateLanAddresses(interfaces = networkInterfaces()) {
  return [...new Set(Object.values(interfaces).flat().filter((item) =>
    item?.family === "IPv4" && !item.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address)
  ).map((item) => item.address))].sort();
}

/** Only this gateway may forward a LAN client's identity to the loopback service. */
export function createGateway(targetPort) {
  return http.createServer((incoming, outgoing) => {
    const headers = { ...incoming.headers, host: `127.0.0.1:${targetPort}` };
    for (const key of ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded"]) delete headers[key];
    headers["x-forwarded-for"] = incoming.socket.remoteAddress;
    const request = http.request({
      host: "127.0.0.1", port: targetPort, method: incoming.method,
      path: incoming.url, headers
    }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    request.on("error", () => {
      if (outgoing.destroyed) return;
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    outgoing.on("close", () => request.destroy());
    incoming.on("aborted", () => request.destroy());
    incoming.pipe(request);
  });
}
