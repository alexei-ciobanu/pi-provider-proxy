import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { ProviderProxyTransport } from "../src/proxy-transport.js";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind to TCP");
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    }),
  );
}

test("proxied fetch reaches the proxy and not the target", async () => {
  let targetHits = 0;
  const target = http.createServer((_request, response) => {
    targetHits += 1;
    response.end("target");
  });
  const targetPort = await listen(target);

  let proxyHits = 0;
  const proxy = http.createServer((_request, response) => {
    proxyHits += 1;
    response.end("proxy");
  });
  const proxyPort = await listen(proxy);
  const transport = new ProviderProxyTransport(`http://127.0.0.1:${proxyPort}`);

  try {
    const response = await transport.fetch(`http://127.0.0.1:${targetPort}/`);
    assert.equal(await response.text(), "proxy");
    assert.equal(proxyHits, 1);
    assert.equal(targetHits, 0);
  } finally {
    await transport.close();
    await close(proxy);
    await close(target);
  }
});
test("request options are provider-scoped and override ambient bypass values", () => {
  const transport = new ProviderProxyTransport("http://127.0.0.1:8118", "sse");
  const options = transport.requestOptions({
    env: { HTTPS_PROXY: "http://wrong.example", NO_PROXY: "chatgpt.com", OTHER: "preserved" },
  });

  assert.equal(options.fetch, transport.fetch);
  assert.equal(options.transport, "sse");
  assert.equal(options.env?.HTTPS_PROXY, "http://127.0.0.1:8118");
  assert.equal(options.env?.NO_PROXY, "__pi_openai_codex_proxy_no_bypass__");
  assert.equal(options.env?.OTHER, "preserved");
});
