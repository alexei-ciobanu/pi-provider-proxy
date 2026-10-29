# pi-provider-proxy

A Pi extension that routes selected built-in model providers through independently configured HTTP(S) proxies.

It does not set `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, or Pi's global `httpProxy` setting. Unselected providers, Pi's
startup requests, extensions, and commands run by the bash tool therefore retain their normal network behavior.

## Supported providers

- `openai`, including API-key and ChatGPT subscription requests, classifier requests, and automatic OAuth token refresh
- `openai-codex` (legacy), including SSE, WebSocket, and automatic OAuth token refresh requests
- `xai`, including `xai/grok-4.5` inference and automatic OAuth token refresh requests

Each provider retains Pi's built-in models and existing sign-in. The extension also refreshes its Pi model catalogue through the configured provider proxy. The extension proxies every model under an
enabled provider; for example, enabling `xai` proxies all direct xAI models, not only `grok-4.5`.

The interactive `/login` browser/device-code exchanges still use Pi's built-in OAuth flows and normal process transport.
Log in before enabling the extension, or temporarily use a process proxy only while performing login.

The extension applies to direct providers. It does not affect `pi-relay-e2ee`; with that provider, upstream model
requests happen in the relay server process.

## Configuration

Create `~/.config/pi-provider-proxy/config.toml`:

```toml
version = 1
reject_ambient_proxy = true

[providers.openai]
enabled = true
proxy_url = "http://127.0.0.1:8118"

[providers.openai-codex]
enabled = true
proxy_url = "http://127.0.0.1:8118"
transport = "auto"

[providers.xai]
enabled = true
proxy_url = "http://127.0.0.1:8118"
```

Requires Pi 1.4.x. Only the supported provider IDs listed above are accepted; adding another requires an implementation and tests.

Provider sections are optional and can use different proxy URLs. Set `enabled = false` to retain a section without
overriding that provider.

`transport` applies only to `openai-codex`. When omitted, the extension preserves Pi's selected transport. Valid values
are `auto`, `sse`, `websocket`, and `websocket-cached`. xAI uses its built-in Responses HTTP transport.

`reject_ambient_proxy` defaults to `true`. It rejects startup when process-wide proxy variables are present, because in
that situation the extension cannot guarantee that only selected providers are proxied. Set it to `false` only if the
broader proxy behavior is intentional.

Override the config location with `PI_PROVIDER_PROXY_CONFIG`. Relative paths resolve from Pi's startup directory. Run
`/reload` after changing the TOML file.

Only `http://` and `https://` proxy URLs are accepted. GOST's HTTP listener is supported; point the extension at GOST
rather than putting a `socks5://` URL in this file.

## Try or install locally

```bash
cd ~/projects/2026-09-01_pi-provider-proxy
bun install
bun run check

# One run
PI_PROVIDER_PROXY_CONFIG="$PWD/fixtures/config.toml" pi -e "$PWD"

# Register as a local user package
pi install "$PWD"
```

Do not start Pi with proxy environment variables when `reject_ambient_proxy = true`; launch plain `pi`. The extension
injects each proxy only into the selected provider's requests.
