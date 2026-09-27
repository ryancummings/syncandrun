import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, test } from "node:test";
import { createGateway, privateLanAddresses } from "../network.mjs";

const servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function listen(server) {
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

test("chooses only private non-loopback IPv4 interfaces", () => {
  assert.deepEqual(privateLanAddresses({
    wifi: [{ family: "IPv4", internal: false, address: "192.168.1.20" }],
    vpn: [{ family: "IPv4", internal: false, address: "100.80.1.2" }],
    loopback: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
    ethernet: [{ family: "IPv4", internal: false, address: "10.1.2.3" }]
  }), ["10.1.2.3", "192.168.1.20"]);
});

test("gateway preserves watch Authorization and body but removes spoofed proxy identity", async () => {
  const backend = http.createServer(async (request, reply) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    reply.setHeader("content-type", "application/json");
    reply.end(JSON.stringify({
      host: request.headers.host,
      forwarded: request.headers["x-forwarded-for"],
      authorization: request.headers.authorization,
      body
    }));
  });
  const backendPort = await listen(backend);
  const gatewayPort = await listen(createGateway(backendPort));
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/api/v1/watch/config`, {
    method: "POST",
    headers: { Authorization: "Bearer synthetic-watch-token", "X-Forwarded-For": "8.8.8.8" },
    body: "fixture"
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    host: `127.0.0.1:${backendPort}`,
    authorization: "Bearer synthetic-watch-token",
    body: "fixture"
  });
});
