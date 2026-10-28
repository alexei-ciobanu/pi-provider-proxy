import assert from "node:assert/strict";
import test from "node:test";
import { configPath, configuredAmbientProxyVariables, parseProxyConfig } from "../src/config.js";

const VALID = `
version = 1
reject_ambient_proxy = true

[providers.openai-codex]
enabled = true
proxy_url = "http://127.0.0.1:8118"
transport = "auto"

[providers.xai]
enabled = true
proxy_url = "http://127.0.0.1:8118"
`;

test("parses independently configured providers", () => {
  assert.deepEqual(parseProxyConfig(VALID), {
    version: 1,
    rejectAmbientProxy: true,
    providers: {
      "openai-codex": {
        enabled: true,
        proxyUrl: "http://127.0.0.1:8118",
        transport: "auto",
      },
      xai: {
        enabled: true,
        proxyUrl: "http://127.0.0.1:8118",
      },
    },
  });
});

test("allows an explicitly disabled provider without a proxy URL", () => {
  const config = parseProxyConfig(`version = 1\n[providers.xai]\nenabled = false\n`);
  assert.equal(config.providers.xai?.enabled, false);
  assert.equal(config.providers.xai?.proxyUrl, undefined);
});

test("rejects unsupported providers", () => {
  assert.throws(
    () => parseProxyConfig(`${VALID}\n[providers.anthropic]\nproxy_url = "http://127.0.0.1:8118"\n`),
    /unsupported key\(s\): anthropic/,
  );
});

test("rejects transport on providers without transport selection", () => {
  assert.throws(() => parseProxyConfig(`${VALID}\ntransport = "sse"\n`), /providers.xai contains unsupported key/);
});

test("rejects non-HTTP proxy protocols", () => {
  assert.throws(
    () => parseProxyConfig(VALID.replaceAll("http://127.0.0.1:8118", "socks5://127.0.0.1:1080")),
    /must use http:\/\/ or https:\/\//,
  );
});

test("resolves a relative config override", () => {
  assert.equal(
    configPath({ PI_PROVIDER_PROXY_CONFIG: "fixtures/config.toml" }),
    `${process.cwd()}/fixtures/config.toml`,
  );
});

test("detects only non-empty ambient proxy variables", () => {
  assert.deepEqual(configuredAmbientProxyVariables({ HTTP_PROXY: "http://proxy", HTTPS_PROXY: " " }), ["HTTP_PROXY"]);
});

test("accepts the OpenAI provider", () => {
  const config = parseProxyConfig('version = 1\n[providers.openai]\nproxy_url = "http://127.0.0.1:8118"\n');
  assert.equal(config.providers.openai?.proxyUrl, "http://127.0.0.1:8118");
});
