import assert from "node:assert/strict";
import test from "node:test";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import {
  createProxiedOpenAICodexProvider,
  createProxiedOpenAIProvider,
  createProxiedXaiProvider,
  refreshOpenAICodexCredential,
  refreshOpenAICredential,
  refreshXaiCredential,
} from "../src/provider.js";
import { ProviderProxyTransport } from "../src/proxy-transport.js";

function jwt(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

function mockTransport(response: Record<string, unknown>): {
  transport: ProviderProxyTransport;
  calls: Array<{ input: string; init?: RequestInit }>;
} {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const transport = new ProviderProxyTransport("http://127.0.0.1:8118");
  Object.defineProperty(transport, "fetch", {
    value: async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input: String(input), init });
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { transport, calls };
}

const credential: OAuthCredential = {
  type: "oauth",
  access: "old-access",
  refresh: "old-refresh",
  expires: 0,
};

test("preserves both built-in provider identities, models, and OAuth login", () => {
  const transport = new ProviderProxyTransport("http://127.0.0.1:8118");
  const codex = createProxiedOpenAICodexProvider(transport);
  const xai = createProxiedXaiProvider(transport);
  assert.equal(codex.id, "openai-codex");
  assert.equal(xai.id, "xai");
  assert.equal(codex.getModels().length > 0, true);
  assert.equal(
    xai.getModels().some((model) => model.id === "grok-4.5"),
    true,
  );
  assert.equal(typeof codex.auth.oauth?.login, "function");
  assert.equal(typeof xai.auth.oauth?.login, "function");
});

test("OpenAI Codex OAuth refresh uses the provider-scoped fetch", async () => {
  const access = jwt("account-123");
  const { transport, calls } = mockTransport({
    access_token: access,
    refresh_token: "new-refresh",
    expires_in: 3600,
  });
  const refreshed = await refreshOpenAICodexCredential(
    credential,
    new AbortController().signal,
    transport,
    "https://auth.example/token",
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.input, "https://auth.example/token");
  assert.equal(refreshed.access, access);
  assert.equal(refreshed.refresh, "new-refresh");
  assert.equal(refreshed.accountId, "account-123");
});

test("xAI OAuth refresh uses the provider-scoped fetch and retains an unrotated refresh token", async () => {
  const { transport, calls } = mockTransport({ access_token: "new-access", expires_in: 3600 });
  const refreshed = await refreshXaiCredential(
    credential,
    new AbortController().signal,
    transport,
    "https://auth.x.example/token",
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.input, "https://auth.x.example/token");
  assert.equal(refreshed.access, "new-access");
  assert.equal(refreshed.refresh, "old-refresh");
  assert.equal(refreshed.expires > Date.now(), true);
});

test("OpenAI provider preserves API key and ChatGPT login and proxies refresh", async () => {
  const { transport, calls } = mockTransport({
    access_token: "new",
    refresh_token: "rotated",
    scope: "openid chatgpt.tokens.use.direct",
    expires_in: 3600,
  });
  const provider = createProxiedOpenAIProvider(transport);
  assert.equal(provider.id, "openai");
  assert.ok(provider.auth.apiKey);
  assert.equal(typeof provider.auth.oauth?.login, "function");
  assert.equal(typeof provider.classify, "function");
  const updated = await refreshOpenAICredential(
    { ...credential, clientId: "issued-client" },
    new AbortController().signal,
    transport,
  );
  assert.equal(calls[0]?.input, "https://auth.openai.com/api/accounts/oauth/token");
  const body = calls[0]?.init?.body as URLSearchParams;
  assert.equal(body.get("client_id"), "issued-client");
  assert.equal(body.get("resource"), "https://api.openai.com/v1");
  assert.equal(updated.refresh, "rotated");
  assert.deepEqual(updated.scopes, ["openid", "chatgpt.tokens.use.direct"]);
});

test("OpenAI refresh rejects a grant without direct access", async () => {
  const { transport } = mockTransport({
    access_token: "new",
    refresh_token: "rotated",
    scope: "openid",
    expires_in: 3600,
  });
  await assert.rejects(
    refreshOpenAICredential({ ...credential, clientId: "client" }, new AbortController().signal, transport),
    /chatgpt.tokens.use.direct/,
  );
});
