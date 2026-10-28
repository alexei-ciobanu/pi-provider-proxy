import type { Transport } from "@earendil-works/pi-ai";
import { ProxyAgent, type RequestInit as UndiciRequestInit, fetch as undiciFetch } from "undici";

const NEVER_BYPASS_PROXY = "__pi_openai_codex_proxy_no_bypass__";

export class ProviderProxyTransport {
  readonly fetch: typeof globalThis.fetch;
  readonly proxyUrl: string;
  readonly transport?: Transport;
  private dispatcher?: ProxyAgent;

  constructor(proxyUrl: string, transport?: Transport) {
    this.proxyUrl = proxyUrl;
    this.transport = transport;
    this.fetch = async (input, init) => {
      this.dispatcher ??= new ProxyAgent({ uri: this.proxyUrl });
      return (await undiciFetch(input as Parameters<typeof undiciFetch>[0], {
        ...(init as UndiciRequestInit | undefined),
        dispatcher: this.dispatcher,
      })) as unknown as Response;
    };
  }

  requestOptions<T extends { env?: Record<string, string | undefined> }>(
    options?: T,
  ): T & { fetch: typeof globalThis.fetch; env: Record<string, string>; transport?: Transport } {
    const proxyEnvironment = {
      HTTP_PROXY: this.proxyUrl,
      HTTPS_PROXY: this.proxyUrl,
      ALL_PROXY: this.proxyUrl,
      http_proxy: this.proxyUrl,
      https_proxy: this.proxyUrl,
      all_proxy: this.proxyUrl,
      NO_PROXY: NEVER_BYPASS_PROXY,
      no_proxy: NEVER_BYPASS_PROXY,
    };
    return {
      ...(options ?? ({} as T)),
      fetch: this.fetch,
      env: { ...options?.env, ...proxyEnvironment },
      ...(this.transport ? { transport: this.transport } : {}),
    } as T & { fetch: typeof globalThis.fetch; env: Record<string, string>; transport?: Transport };
  }

  async close(): Promise<void> {
    const dispatcher = this.dispatcher;
    this.dispatcher = undefined;
    await dispatcher?.close();
  }
}
