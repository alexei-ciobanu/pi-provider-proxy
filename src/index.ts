import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  configPath,
  configuredAmbientProxyVariables,
  loadProxyConfig,
  type ProxyConfig,
  SUPPORTED_PROVIDER_IDS,
  type SupportedProviderId,
} from "./config.js";
import { createProxiedOpenAICodexProvider, createProxiedXaiProvider } from "./provider.js";
import { ProviderProxyTransport } from "./proxy-transport.js";

function providerFor(id: SupportedProviderId, transport: ProviderProxyTransport) {
  if (id === "openai-codex") return createProxiedOpenAICodexProvider(transport);
  return createProxiedXaiProvider(transport);
}

export async function registerProviderProxies(pi: ExtensionAPI, config: ProxyConfig): Promise<void> {
  const enabled = SUPPORTED_PROVIDER_IDS.flatMap((id) => {
    const provider = config.providers[id];
    return provider?.enabled ? [{ id, config: provider }] : [];
  });
  if (enabled.length === 0) return;

  if (config.rejectAmbientProxy) {
    const ambient = configuredAmbientProxyVariables();
    if (ambient.length > 0) {
      throw new Error(
        `Provider-only proxying requires ambient proxy variables to be unset; found: ${ambient.join(", ")}`,
      );
    }
  }

  const transports: ProviderProxyTransport[] = [];
  for (const entry of enabled) {
    if (!entry.config.proxyUrl) throw new Error(`Enabled ${entry.id} proxy has no proxy URL`);
    const transport = new ProviderProxyTransport(entry.config.proxyUrl, entry.config.transport);
    transports.push(transport);
    pi.registerProvider(providerFor(entry.id, transport));
  }
  pi.on("session_shutdown", async () => {
    await Promise.all(transports.map((transport) => transport.close()));
  });
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const path = configPath();
  const config = await loadProxyConfig(path);
  await registerProviderProxies(pi, config);
}
