import {
  type Api,
  type ClassifierApi,
  type ClassifierModel,
  getModelType,
  type ImageApi,
  type ImageModel,
  isModelType,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";
import type { ProviderProxyTransport } from "./proxy-transport.js";

type ProviderModel<T extends Api> = Model<T> | ImageModel<ImageApi> | ClassifierModel<ClassifierApi>;

const INTERVAL_MS = 4 * 60 * 60 * 1000;

async function fetchCatalog(
  transport: ProviderProxyTransport,
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Response> {
  const retryable = new Set([408, 425, 429, 500, 502, 503, 504]);
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      const response = await transport.fetch(url, {
        headers,
        signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]),
      });
      if (attempt >= 2 || !retryable.has(response.status)) return response;
      await response.body?.cancel().catch(() => {});
    } catch (error) {
      if (signal.aborted || attempt >= 2) throw error;
    }
  }
}

/** Restore Pi's remote catalog overlay, using the provider's proxy for catalog requests. */
export function withProxiedCatalog<T extends Api>(
  provider: Provider<T>,
  transport: ProviderProxyTransport,
): Provider<T> {
  let dynamic: ProviderModel<T>[] = [];
  const generatedAt = getBuiltinModelDataGeneratedAt();
  const newer = (lastModified?: number) =>
    generatedAt === undefined || (lastModified !== undefined && lastModified > generatedAt);
  const merge = (baseline: readonly ProviderModel<T>[], extra: readonly ProviderModel<T>[]) => {
    const models = new Map<string, ProviderModel<T>>();
    for (const model of [...baseline, ...extra]) models.set(`${getModelType(model)}\0${model.id}`, model);
    return [...models.values()];
  };
  return {
    ...provider,
    getModels: () => merge(provider.getModels(), dynamic).filter((model) => isModelType(model, "chat")),
    getAllModels: () => merge(provider.getAllModels?.() ?? provider.getModels(), dynamic),
    refreshModels: async (context) => {
      const stored = context.stored;
      const restored = newer(stored?.lastModified)
        ? (stored?.models ?? []).filter((model) => model.provider === provider.id)
        : [];
      if (
        !(await context.publish({
          update: () => {
            dynamic = restored as ProviderModel<T>[];
          },
        }))
      )
        return;
      if (!context.allowNetwork || context.signal.aborted) return;
      if (
        !context.force &&
        stored?.checkedAt !== undefined &&
        stored.lastModified !== undefined &&
        Date.now() - stored.checkedAt < INTERVAL_MS
      )
        return;
      const url = new URL(`/api/models/providers/${encodeURIComponent(provider.id)}`, "https://pi.dev");
      url.searchParams.set("types", "chat,image,classifier");
      const response = await fetchCatalog(
        transport,
        url,
        {
          accept: "application/json",
          ...(stored?.models.length && stored.etag ? { "if-none-match": stored.etag } : {}),
        },
        context.signal,
      );
      if (context.signal.aborted) return;
      const checkedAt = Date.now();
      if (response.status === 304 && stored) {
        await context.publish({ persist: { ...stored, checkedAt } });
        return;
      }
      if (response.status === 404 || response.status === 501) {
        await context.publish({
          persist: { ...(stored ?? { models: [] }), checkedAt, lastModified: 0, etag: undefined },
        });
        return;
      }
      if (!response.ok) {
        await context.publish({ persist: { ...(stored ?? { models: [] }), checkedAt } });
        throw new Error(`Model catalog request failed for ${provider.id}: ${response.status}`);
      }
      const data: unknown = await response.json();
      const entries = Array.isArray(data)
        ? data
        : data && typeof data === "object" && "models" in data && Array.isArray(data.models)
          ? data.models
          : data && typeof data === "object"
            ? Object.values(data)
            : undefined;
      if (!entries) throw new Error(`Invalid model catalog for provider "${provider.id}"`);
      const models = entries
        .filter(
          (entry) =>
            entry &&
            typeof entry === "object" &&
            "id" in entry &&
            (entry.type === undefined || ["chat", "image", "classifier"].includes(entry.type)),
        )
        .map((entry) => ({ ...entry, provider: provider.id })) as ProviderModel<T>[];
      const lastModified = Date.parse(response.headers.get("last-modified") ?? "") || 0;
      const entry = { models, checkedAt, lastModified, etag: response.headers.get("etag") ?? undefined };
      await context.publish({
        persist: entry,
        update: () => {
          dynamic = newer(lastModified) ? models : [];
        },
      });
    },
  };
}
