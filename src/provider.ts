import type { Api, OAuthCredential, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ProviderProxyTransport } from "./proxy-transport.js";

const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_JWT_CLAIM_PATH = "https://api.openai.com/auth";
const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_REFRESH_SKEW_MS = 5 * 60 * 1000;
const XAI_DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;

function builtinProvider<TApi extends Api>(id: string): Provider<TApi> {
  const provider = builtinProviders().find((candidate) => candidate.id === id);
  if (!provider) throw new Error(`Built-in ${id} provider is unavailable`);
  return provider as Provider<TApi>;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function openaiAccountId(token: string): string {
  const payload = decodeJwtPayload(token);
  const auth = payload?.[OPENAI_JWT_CLAIM_PATH];
  const value = auth && typeof auth === "object" ? (auth as Record<string, unknown>).chatgpt_account_id : undefined;
  if (typeof value !== "string" || value.length === 0) throw new Error("OpenAI Codex access token lacks account id");
  return value;
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed = await response.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new Error(`OAuth endpoint returned invalid JSON (HTTP ${response.status})`);
  }
}

export async function refreshOpenAICodexCredential(
  credential: OAuthCredential,
  signal: AbortSignal,
  transport: ProviderProxyTransport,
  tokenUrl = OPENAI_TOKEN_URL,
): Promise<OAuthCredential> {
  let response: Response;
  try {
    response = await transport.fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credential.refresh,
        client_id: OPENAI_CLIENT_ID,
      }),
      signal,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`OpenAI Codex token refresh error: ${reason}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenAI Codex token refresh failed (${response.status}): ${body || response.statusText}`);
  }
  const value = await responseBody(response);
  if (
    typeof value.access_token !== "string" ||
    typeof value.refresh_token !== "string" ||
    typeof value.expires_in !== "number"
  ) {
    throw new Error("OpenAI Codex token refresh response missing fields");
  }
  return {
    ...credential,
    type: "oauth",
    access: value.access_token,
    refresh: value.refresh_token,
    expires: Date.now() + value.expires_in * 1000,
    accountId: openaiAccountId(value.access_token),
  };
}

function xaiFailure(response: Response, body: Record<string, unknown>): Error {
  const error = typeof body.error === "string" ? body.error : undefined;
  const description = typeof body.error_description === "string" ? body.error_description : undefined;
  const detail = [error, description].filter(Boolean).join(": ");
  return new Error(`xAI OAuth token refresh failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
}

export async function refreshXaiCredential(
  credential: OAuthCredential,
  signal: AbortSignal,
  transport: ProviderProxyTransport,
  tokenUrl = XAI_TOKEN_URL,
): Promise<OAuthCredential> {
  let response: Response;
  try {
    response = await transport.fetch(tokenUrl, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: XAI_CLIENT_ID,
        refresh_token: credential.refresh,
      }),
      signal,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`xAI OAuth token refresh error: ${reason}`);
  }

  const body = await responseBody(response);
  if (!response.ok) throw xaiFailure(response, body);
  if (typeof body.access_token !== "string" || body.access_token.length === 0) {
    throw new Error("xAI OAuth token refresh response missing access_token");
  }
  const refresh = body.refresh_token === undefined ? credential.refresh : body.refresh_token;
  if (typeof refresh !== "string" || refresh.length === 0) {
    throw new Error("xAI OAuth token refresh response has invalid refresh_token");
  }
  const expiresIn = body.expires_in === undefined ? XAI_DEFAULT_TOKEN_LIFETIME_SECONDS : body.expires_in;
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("xAI OAuth token refresh response has invalid expires_in");
  }
  return {
    ...credential,
    type: "oauth",
    access: body.access_token,
    refresh,
    expires: Date.now() + expiresIn * 1000 - XAI_REFRESH_SKEW_MS,
  };
}

export function createProxiedOpenAICodexProvider(
  transport: ProviderProxyTransport,
): Provider<"openai-codex-responses"> {
  const base = builtinProvider<"openai-codex-responses">("openai-codex");
  const oauth = base.auth.oauth;
  if (!oauth) throw new Error("Built-in openai-codex OAuth provider is unavailable");

  return {
    ...base,
    auth: {
      ...base.auth,
      oauth: {
        ...oauth,
        refresh: (credential, signal) => refreshOpenAICodexCredential(credential, signal, transport),
      },
    },
    stream: (model, context, options) => base.stream(model, context, transport.requestOptions(options)),
    streamSimple: (model, context, options) => base.streamSimple(model, context, transport.requestOptions(options)),
  };
}

export function createProxiedXaiProvider(transport: ProviderProxyTransport): Provider<"openai-responses"> {
  const base = builtinProvider<"openai-responses">("xai");
  const oauth = base.auth.oauth;
  if (!oauth) throw new Error("Built-in xAI OAuth provider is unavailable");

  return {
    ...base,
    auth: {
      ...base.auth,
      oauth: {
        ...oauth,
        refresh: (credential, signal) => refreshXaiCredential(credential, signal, transport),
      },
    },
    stream: (model, context, options) => base.stream(model, context, transport.requestOptions(options)),
    streamSimple: (model, context, options) => base.streamSimple(model, context, transport.requestOptions(options)),
  };
}

export async function refreshOpenAICredential(
  credential: OAuthCredential,
  signal: AbortSignal,
  transport: ProviderProxyTransport,
  tokenUrl = "https://auth.openai.com/api/accounts/oauth/token",
): Promise<OAuthCredential> {
  const clientId = credential.clientId;
  if (typeof clientId !== "string" || !clientId.trim()) {
    throw new Error("Stored OpenAI OAuth credential does not contain an issued client ID; reconnect ChatGPT");
  }
  const response = await transport.fetch(tokenUrl, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: credential.refresh,
      resource: "https://api.openai.com/v1",
    }),
    signal,
  });
  if (!response.ok) throw new Error(`OpenAI OAuth token request failed (${response.status}): ${await response.text()}`);
  const token = await responseBody(response);
  if (
    typeof token.access_token !== "string" ||
    !token.access_token.trim() ||
    typeof token.refresh_token !== "string" ||
    !token.refresh_token.trim() ||
    typeof token.scope !== "string" ||
    !token.scope.trim() ||
    typeof token.expires_in !== "number" ||
    !Number.isFinite(token.expires_in) ||
    token.expires_in <= 0
  ) {
    throw new Error("OpenAI OAuth token response has invalid fields");
  }
  const scopes = token.scope.trim().split(/\s+/);
  if (!scopes.includes("chatgpt.tokens.use.direct"))
    throw new Error("OpenAI OAuth grant did not include chatgpt.tokens.use.direct");
  return {
    type: "oauth",
    access: token.access_token,
    refresh: token.refresh_token,
    expires: Date.now() + token.expires_in * 1000 - 180_000,
    clientId,
    scopes,
  };
}

export function createProxiedOpenAIProvider(transport: ProviderProxyTransport): Provider<"openai-responses"> {
  const base = builtinProvider<"openai-responses">("openai");
  const oauth = base.auth.oauth;
  if (!oauth) throw new Error("Built-in openai ChatGPT OAuth provider is unavailable; Pi 1.4 is required");
  const classify = base.classify;
  return {
    ...base,
    auth: {
      ...base.auth,
      oauth: { ...oauth, refresh: (credential, signal) => refreshOpenAICredential(credential, signal, transport) },
    },
    stream: (model, context, options) => base.stream(model, context, transport.requestOptions(options)),
    streamSimple: (model, context, options) => base.streamSimple(model, context, transport.requestOptions(options)),
    ...(classify
      ? { classify: (model, context, options) => classify(model, context, transport.requestOptions(options)) }
      : {}),
  };
}
