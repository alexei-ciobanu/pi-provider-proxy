import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Transport } from "@earendil-works/pi-ai";
import { parse } from "smol-toml";

const CONFIG_ENV = "PI_PROVIDER_PROXY_CONFIG";
const TRANSPORTS = new Set<Transport>(["auto", "sse", "websocket", "websocket-cached"]);
export const SUPPORTED_PROVIDER_IDS = ["openai", "openai-codex", "xai"] as const;
export type SupportedProviderId = (typeof SUPPORTED_PROVIDER_IDS)[number];

export interface ProviderProxyConfig {
  readonly enabled: boolean;
  readonly proxyUrl?: string;
  readonly transport?: Transport;
}

export interface ProxyConfig {
  readonly version: 1;
  readonly rejectAmbientProxy: boolean;
  readonly providers: Partial<Record<SupportedProviderId, ProviderProxyConfig>>;
}

type Table = Record<string, unknown>;

function table(value: unknown, path: string): Table {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be a TOML table`);
  }
  return value as Table;
}

function onlyKeys(value: Table, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new Error(`${path} contains unsupported key(s): ${unknown.join(", ")}`);
}

function optionalBoolean(value: unknown, fallback: boolean, path: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function proxyUrl(value: unknown, enabled: boolean, path: string): string | undefined {
  if (value === undefined && !enabled) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path}.proxy_url must be a non-empty string when enabled`);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${path}.proxy_url must be a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${path}.proxy_url must use http:// or https://`);
  }
  if ((parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) {
    throw new Error(`${path}.proxy_url must be an origin without a path, query, or fragment`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function transport(value: unknown, path: string): Transport | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !TRANSPORTS.has(value as Transport)) {
    throw new Error(`${path}.transport must be auto, sse, websocket, or websocket-cached`);
  }
  return value as Transport;
}

function parseProvider(id: SupportedProviderId, value: unknown): ProviderProxyConfig {
  const path = `providers.${id}`;
  const provider = table(value, path);
  const allowedKeys = id === "openai-codex" ? ["enabled", "proxy_url", "transport"] : ["enabled", "proxy_url"];
  onlyKeys(provider, allowedKeys, path);
  const enabled = optionalBoolean(provider.enabled, true, `${path}.enabled`);
  return {
    enabled,
    proxyUrl: proxyUrl(provider.proxy_url, enabled, path),
    ...(id === "openai-codex" ? { transport: transport(provider.transport, path) } : {}),
  };
}

export function parseProxyConfig(source: string): ProxyConfig {
  const root = table(parse(source), "config");
  onlyKeys(root, ["version", "reject_ambient_proxy", "providers"], "config");
  if (root.version !== 1) throw new Error("config.version must be 1");

  const providerTable = table(root.providers, "providers");
  onlyKeys(providerTable, SUPPORTED_PROVIDER_IDS, "providers");
  const providers: ProxyConfig["providers"] = {};
  for (const id of SUPPORTED_PROVIDER_IDS) {
    if (providerTable[id] !== undefined) providers[id] = parseProvider(id, providerTable[id]);
  }

  return {
    version: 1,
    rejectAmbientProxy: optionalBoolean(root.reject_ambient_proxy, true, "reject_ambient_proxy"),
    providers,
  };
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[CONFIG_ENV]?.trim();
  const path = expandHome(configured || join(homedir(), ".config", "pi-provider-proxy", "config.toml"));
  return isAbsolute(path) ? path : resolve(path);
}

export async function loadProxyConfig(path: string): Promise<ProxyConfig> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read proxy config ${path}: ${reason}`);
  }
  try {
    return parseProxyConfig(source);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid proxy config ${path}: ${reason}`);
  }
}

export const AMBIENT_PROXY_VARIABLES = [
  "http_proxy",
  "HTTP_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
  "all_proxy",
  "ALL_PROXY",
] as const;

export function configuredAmbientProxyVariables(env: NodeJS.ProcessEnv = process.env): string[] {
  return AMBIENT_PROXY_VARIABLES.filter((name) => Boolean(env[name]?.trim()));
}
