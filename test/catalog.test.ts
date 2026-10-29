import assert from "node:assert/strict";
import test from "node:test";
import { withProxiedCatalog } from "../src/catalog.js";
import { createProxiedOpenAIProvider } from "../src/provider.js";
import { ProviderProxyTransport } from "../src/proxy-transport.js";

test("refresh restores and updates the OpenAI catalog through provider fetch", async () => {
  const transport = new ProviderProxyTransport("http://127.0.0.1:8118");
  const base = createProxiedOpenAIProvider(transport);
  const existing = base.getModels()[0];
  assert.ok(existing);
  const newModel = { ...existing, id: "new-model-from-catalog" };
  const calls: string[] = [];
  Object.defineProperty(transport, "fetch", {
    value: async (url: URL) => {
      calls.push(url.toString());
      return new Response(JSON.stringify({ models: [newModel] }), {
        headers: { "last-modified": "Wed, 01 Jan 2099 00:00:00 GMT", etag: '"test"' },
      });
    },
  });
  const provider = withProxiedCatalog(base, transport);
  let stored: Parameters<NonNullable<typeof provider.refreshModels>>[0]["stored"];
  const signal = new AbortController().signal;
  const publish: Parameters<NonNullable<typeof provider.refreshModels>>[0]["publish"] = async (publication) => {
    if (publication.persist) stored = publication.persist;
    publication.update?.();
    return true;
  };
  await provider.refreshModels?.({ allowNetwork: true, signal, publish });
  assert.deepEqual(calls, ["https://pi.dev/api/models/providers/openai?types=chat%2Cimage%2Cclassifier"]);
  assert.ok(provider.getModels().some((model) => model.id === newModel.id));
  assert.equal(stored?.etag, '"test"');
  const reloaded = withProxiedCatalog(base, transport);
  await reloaded.refreshModels?.({ allowNetwork: false, signal, stored, publish });
  assert.ok(reloaded.getModels().some((model) => model.id === newModel.id));
  assert.equal(calls.length, 1);
});
