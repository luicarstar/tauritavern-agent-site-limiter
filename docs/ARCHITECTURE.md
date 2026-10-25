# Architecture and compatibility

This project contains a third-party TT frontend extension and a dependency-free local Node.js HTTP relay. It does not patch the Tauri executable or install a system-wide network interceptor.

```text
Agent connection capture / saved LLM connection
  -> frontend site rule match
  -> local transport URL (same model and credential reference)
  -> per-origin FIFO queue + rolling RPM limit
  -> original upstream HTTP/SSE endpoint
```

The frontend wraps the public method objects used by TT 2.4.0:

- `api.agent.promptAssembly.buildCurrentModelConnectionSnapshot`
- `api.agent.promptAssembly.applyCurrentModelConnectionSnapshot`
- `api.agent.promptAssembly.buildSnapshot`
- `api.agent.startRunWithPromptSnapshot`
- `api.llmConnections.save`

Saved connection synchronization is routed through the same save method. The Rust Agent runtime still resolves credentials and performs the HTTP call; its destination is replaced with a local relay URL. User-facing connection settings and model IDs are not replaced with special model names.

Request permits cover the entire HTTP response or SSE stream. They never cover the lifetime of a parent Agent, so a parent waiting for a child cannot deadlock the request queue. Upstream retries are left to TT; every new HTTP attempt counts toward RPM.

Rules use URL origins: scheme, host and port. Model names, API paths and credential references do not partition the quota. Each origin has an independent limiter and accounting history.

## Compatibility boundaries

Tested against TauriTavern 2.4.0 on Windows. This is an independent compatibility extension, not an official TT throttling API. A future TT version can require adaptations to these wrappers.

Supported: custom OpenAI-compatible Chat Completions, Responses over HTTP, Claude Messages, Gemini GenerateContent and Gemini Interactions, with HTTP/SSE responses. The relay is not a WebSocket proxy. Provider-specific cloud authentication and fixed built-in provider endpoints are outside the current scope.

New Agent runs started after extension initialization are covered. Previously frozen checkpoints or already running invocations can retain their earlier transport. Ordinary chat, other programs and direct HTTP calls that do not pass through these Agent boundaries are not globally intercepted.

The relay connects directly to its upstream. It does not inherit TT's Request Proxy configuration. A working relay process and TT's own endpoint authorization are required.

## Local data

The relay listens only on `127.0.0.1`; its management API requires a random pairing token. Route URLs also contain random tokens. Browser-origin and Host checks restrict requests to expected local clients. Redirects are rejected rather than forwarded to TT's HTTP client.

The relay persists site rules, upstream base URLs and request timestamps, never request bodies or responses. TT extension storage preserves original connection definitions to support restoration. Those definitions may include manually entered authentication headers; keep local backups and `runtime/` private. Credentials referenced by TT are still resolved by TT.

Before disabling the extension or stopping the relay permanently, disable the site rules and save, allowing native connections to be restored. If the relay is unavailable while a connection is routed, it fails rather than silently bypassing limits.
