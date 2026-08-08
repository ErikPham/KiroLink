# KiroLink

Anthropic & OpenAI compatible proxy backed by Kiro. Works with **Claude Code** and **Codex**.

Auth via `kiro-cli` cache **or** a Kiro API key. Supports tool_use, thinking, streaming.

Maintainer docs:

- [CHANGELOG.md](./CHANGELOG.md)
- [RELEASING.md](./RELEASING.md)

## Prerequisites

### Which auth mode is used?

Choose with **`--auth`** / **`KIROLINK_AUTH`** / saved config (default: **`cli`**):

| Mode | Flag | What it uses |
|---|---|---|
| **cli** (default) | `--auth cli` | `kiro-cli` OAuth cache (`~/.aws/sso/cache/`) |
| **api-key** | `--auth api-key` | Saved or provided Kiro API key. No OAuth, no `profileArn`. |

**Priority:** CLI flag > env var > **saved config** > default.

Auth settings (`auth`, `kiroApiKey`, `apiRegion`) are **auto-saved** to:

```text
~/.config/kirolink/config.json   # or $XDG_CONFIG_HOME/kirolink/config.json
# override with KIROLINK_CONFIG=/path/to/config.json
```

File mode is `0600`. After the first successful start you can omit key/region:

```bash
# first time
kirolink --auth api-key --kiro-api-key 'your-key' --api-region eu-central-1

# later
kirolink --auth api-key          # reuses saved key + region
kirolink                         # reuses last saved mode too
```

On boot:

```text
kirolink listening on http://127.0.0.1:4119  auth=cli (kiro-cli cache)
  credits 12.3/50 used · 37.7 remaining · reset 2026-08-01 · Kiro Pro
```

### Credits / quota

KiroLink calls Kiro `getUsageLimits` (same source as the IDE usage UI):

| Surface | Behavior |
|---|---|
| Startup log | Prints used / remaining / reset date |
| `GET /v1/usage` | JSON summary (alias: `GET /credits`) |
| `?refresh=1` | Bypass 60s cache |
| `KIROLINK_REQUIRE_CREDITS=1` | Reject chat when remaining ≤ 0 |

```bash
curl -s http://127.0.0.1:4119/v1/usage | jq
# { "ok": true, "used": 12.3, "limit": 50, "remaining": 37.7, "exhausted": false, ... }
```

### Option A — kiro-cli (default)

```bash
# Install Kiro CLI — see https://docs.kiro.dev/cli
kiro-cli login
kirolink                    # same as --auth cli
kirolink --auth cli
```

KiroLink reads the token that `kiro-cli` manages from `~/.aws/sso/cache/`.

### Option B — Kiro API key

```bash
kirolink --auth api-key --kiro-api-key 'your-kiro-api-key' --api-region eu-central-1

# next runs (key + region already in ~/.config/kirolink/config.json)
kirolink --auth api-key
# or just (if last saved mode was api-key)
kirolink
```

Upstream requests send `Authorization: Bearer <key>` and `tokentype: API_KEY`.

## Install

```bash
# npm
npm install -g kirolink

# pnpm
pnpm add -g kirolink

# From source
git clone https://github.com/ErikPham/KiroLink
cd KiroLink
pnpm install && pnpm build
```

## Usage

```bash
# Start proxy
kirolink

# Quiet mode (hide request traces)
kirolink -q

# Custom port
kirolink -p 8080
```

### Claude Code

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:4119 ANTHROPIC_AUTH_TOKEN=dummy claude
```

### Codex (OpenAI)

```bash
OPENAI_BASE_URL=http://127.0.0.1:4119/v1 OPENAI_API_KEY=dummy codex
```

## Run in the background (tray)

`kirolink tray` runs the proxy detached and shows a small status icon: a
menu-bar item on macOS, a notification-area icon on Windows, and an
AppIndicator (or `yad`) icon on Linux. The menu shows credits and request
count, and offers open-dashboard, copy-URL, restart, stop, and quit.

```bash
kirolink tray            # start detached (same as: tray start)
kirolink tray status     # is it running? where?
kirolink tray restart    # restart in place
kirolink tray stop       # stop it
```

If no tray backend is available (no Swift toolchain on macOS, no PowerShell on
Windows, no AppIndicator/`yad` on Linux) the proxy still runs **headless** and
`tray status` reports why. On Linux, install a backend for the icon:

```bash
apt install gir1.2-ayatanaappindicator3-0.1 python3-gi   # or: apt install yad
```

Runtime state (pid, current port, base URL) lives in
`~/.config/kirolink/runtime/` and logs go to `runtime/tray.log`.

## First-run setup & diagnostics

```bash
kirolink setup     # interactive wizard: pick auth mode, enter key, save config
kirolink doctor    # check auth, credits, network reachability, and port
```

`serve` also drops into the wizard automatically the first time you start in
api-key mode with no key configured (when a terminal is attached).

## Dashboard

Opening the base URL in a browser shows a live dashboard: status, credits,
recent requests, and a copy-URL button. It polls `GET /v1/status` and never
forces a quota lookup, so leaving it open does not burn credits.

## Options

```
  -p, --port <port>           Listen port (default: 4119)
      --host <host>           Listen host (default: 127.0.0.1)
  -q, --quiet                 Hide request traces
      --max-concurrent <n>    Max concurrent Kiro API calls (default: 2)
      --delay <ms>            Delay between queued requests (default: 200)
      --api-key <key>         Require API key for clients (protects this proxy)
      --auth <cli|api-key>    Upstream auth mode (default: cli, remembered)
      --kiro-api-key <key>    Upstream Kiro API key (remembered)
      --api-region <region>   Kiro runtime region (remembered; default: us-east-1)
  -h, --help                  Show help
```

## Environment Variables

```
KIROLINK_PORT=4119
KIROLINK_HOST=127.0.0.1
KIROLINK_API_KEY=your-client-key          # protect this proxy (optional on localhost)
KIROLINK_AUTH=cli|api-key                 # upstream auth mode (default: cli)
KIROLINK_KIRO_API_KEY=your-kiro-api-key   # used when auth=api-key (also saved to config)
KIROLINK_API_REGION=us-east-1             # used when KIROLINK_API_URL is unset
KIROLINK_CONFIG=~/.config/kirolink/config.json
KIROLINK_REQUIRE_CREDITS=0                # 1 = reject chat when credits remaining are 0
KIROLINK_MAX_CONCURRENT=2
KIROLINK_DELAY_MS=200
KIROLINK_MAX_BODY_BYTES=16777216
KIROLINK_TOKEN_PATH=~/.aws/sso/cache/kiro-auth-token.json
KIROLINK_API_URL=https://runtime.us-east-1.kiro.dev/
KIROLINK_ALLOW_UNTRUSTED_API_URL=0
KIROLINK_CODEWHISPERER_OPTOUT=true
KIROLINK_REQUEST_TIMEOUT_MS=600000
KIROLINK_RANDOM_CONVERSATION_ID=1
KIROLINK_THINKING_EFFORT=low|medium|high|xhigh|max
KIROLINK_FORCE_THINKING_EFFORT=0
KIROLINK_FILTER_SYSTEM_PROMPT=0
KIROLINK_INJECT_THINKING_PROMPT=0
KIROLINK_MAX_TOOLS=256
KIROLINK_MAX_TOOL_SCHEMA_BYTES=131072
KIROLINK_MAX_TOTAL_TOOL_SCHEMA_BYTES=786432
KIROLINK_DUMP_FAILED_PAYLOAD=0
KIROLINK_FAILED_PAYLOAD_PATH=/tmp/kiro-failed-payload.json
KIROLINK_EXPOSE_UPSTREAM_ERRORS=0
KIROLINK_LOG_JSON=0                       # 1 = newline-delimited JSON logs
```

> **Legacy names.** `KIROLINK_*` is canonical. The older `KIRO_PROXY_*` spelling of
> every variable above is still read, so existing scripts keep working. When both
> are set, the `KIROLINK_*` value wins.

## Use as a library

The package ships an embeddable API alongside the CLI, with TypeScript
declarations:

```ts
import { createKiroLink, loadConfig } from 'kirolink'

const { config } = loadConfig()
const app = createKiroLink(config)
app.server.listen(config.server.port, config.server.host)
```

Any part of the graph can be replaced — useful for tests, custom transports, or
routing to a different upstream:

```ts
import { createKiroLink, loadConfig, type KiroClient } from 'kirolink'

const client: KiroClient = {
  async send(request, onEvent) {
    onEvent({ type: 'text', text: 'hello' })
    onEvent({ type: 'done', inputTokens: 1, outputTokens: 1 })
  },
}

const { config } = loadConfig()
const app = createKiroLink(config, { client })
```

`logger`, `auth`, `client`, `throttle`, and `usage` are all injectable. See
[ARCHITECTURE.md](./ARCHITECTURE.md) for the contracts.

## How it works

```
Claude Code ──→ /v1/messages ──→ KiroLink ──→ Kiro API
Codex ─────→ /v1/chat/completions ─┘              │
                                         ┌────────┴────────┐
                                         │  --auth mode    │
                          cli → kiro-cli cache    api-key → Kiro API key
                          (~/.aws/sso/cache/)              (tokentype: API_KEY)
                                                    ↕
                                         ~/.config/kirolink/config.json
```

1. Resolves upstream auth (CLI > env > saved config > default `cli`):
   - **cli**: reads token from Kiro's auth cache (prefers `KIROLINK_TOKEN_PATH`, otherwise auto-detects in `~/.aws/sso/cache/`) and refreshes via `kiro-cli` when expired
   - **api-key**: Bearer key + `tokentype: API_KEY`, no refresh, no `profileArn`
2. Saves `auth` / `kiroApiKey` / `apiRegion` to the local config file for next runs
3. Translates API requests → Kiro `generateAssistantResponse`
4. Parses AWS Event Stream binary response
5. Translates back to Anthropic/OpenAI format
6. Throttles concurrent requests to avoid rate limits

Runtime safety notes:

- `KIROLINK_API_URL` must use `https`.
- API URL overrides are restricted to known Kiro runtime hosts unless `KIROLINK_ALLOW_UNTRUSTED_API_URL=1` is set.
- API keys must be at least 16 bytes when configured.
- Thinking is sent through Kiro runtime `additionalModelRequestFields.output_config.effort` when the model supports it, not by prompt injection.
- CodeWhisperer data opt-out defaults to `true`; set `KIROLINK_CODEWHISPERER_OPTOUT=false` only if you intentionally want to mirror that header differently.
- Claude/Codex system prompts are preserved by default. `KIROLINK_FILTER_SYSTEM_PROMPT=1` and `KIROLINK_INJECT_THINKING_PROMPT=1` are experimental opt-ins.
- Tool names, tool IDs, tool-result links, model IDs, image media types, output token limits, and schema sizes are validated before a request is sent to Kiro.
- Failed payload dumps are disabled by default because they may contain prompt or tool output data. Enable `KIROLINK_DUMP_FAILED_PAYLOAD=1` only for local debugging.
- Upstream Kiro error bodies are hidden from client-facing messages by default. Set `KIROLINK_EXPOSE_UPSTREAM_ERRORS=1` only for local debugging when a `400` needs its runtime validation detail.
- KiroLink does not drop conversation history to fit a size budget — Kiro CLI itself forwards history as given and lets the runtime report overflow explicitly, so KiroLink does the same. A single oversized field (e.g. a large tool result) is still capped, but the request is otherwise sent as-is. When Kiro reports `REQUEST_BODY_INVALID` or `ContextWindowOverflow` (including if it arrives with an unexpected 5xx status), KiroLink translates it into the canonical context-length error so Claude Code / Codex can trigger their own compaction. For streaming requests, response headers are deferred until Kiro accepts the request, so this signal remains an HTTP 400 rather than an SSE error with status 200.

### Runtime verification against Kiro CLI

The direct runtime API is not a public API contract, so KiroLink treats Kiro CLI as a drift oracle and validates risky assumptions with live runtime probes before changing the proxy body. The local Kiro CLI binary exposes runtime fields such as `GenerateAssistantResponseInput`, `conversationState`, `agentMode`, `additionalModelRequestFields`, `output_config.effort`, `ToolSpecification`, `ToolResultContentBlock`, and runtime validation errors for tool config, thinking signatures, images, and prompt size.

To compare KiroLink with a real Kiro CLI request, record a sanitized CLI request:

```bash
pnpm run runtime:record -- --out .kiro-recordings/latest --model claude-sonnet-4.6
pnpm run runtime:analyze -- .kiro-recordings/latest
```

This uses Kiro CLI's own `KIRO_RECORD_API_REQUESTS_PATH` and `KIRO_RECORD_API_RESPONSES_PATH` hooks, then writes:

- `.kiro-recordings/latest/requests.sanitized.jsonl`
- `.kiro-recordings/latest/responses.sanitized.jsonl`
- sanitized stdout/stderr logs

The command runs `kiro-cli chat --no-interactive --agent-engine v2 --trust-tools=` with a minimal prompt. Raw `*.raw.jsonl` files may still contain prompt or auth-adjacent metadata; inspect the sanitized files first and delete raw files when done.

If you need to capture a different `kiro-cli` invocation, pass the exact CLI
args after a literal `--`. They replace the default text-only chat command:

```bash
pnpm run runtime:record -- --out .kiro-recordings/custom -- chat --help
pnpm run runtime:record -- --out .kiro-recordings/custom -- chat --no-interactive --agent-engine v2 --trust-tools= --wrap never "Reply with exactly: OK"
```

This passthrough mode is the safest way to compare KiroLink assumptions against
the real local CLI behavior because it records the exact command under test
instead of reconstructing it in the proxy.

For the desktop image path, use the dedicated capture harness:

```bash
pnpm run runtime:capture-image -- --image /absolute/path/to/test.png
pnpm run runtime:capture-image -- --image /absolute/path/to/test.png --prompt "Describe the pasted image in exactly one word."
```

`runtime:capture-image` starts `mitmdump`, injects the mitm CA into the local
Kiro desktop process, copies the image into the macOS clipboard, launches the
desktop app through the proxy, and attempts to paste and submit the prompt via
AppleScript. It writes parsed request and response artifacts into
`/tmp/kiro-desktop-capture-<timestamp>` by default.

Use `--manual` when you want the script to prepare the clipboard and capture
environment but you prefer to paste the image yourself:

```bash
pnpm run runtime:capture-image -- --image /absolute/path/to/test.png --manual
```

`runtime:analyze` reports top-level request keys, message/context keys, tool schema wrappers, response event kinds, and drift warnings. Use that report before changing the proxy request body; Kiro CLI recordings may use internal snake_case wrapper names even when the service client path still uses generated service fields.

To validate the actual service wire shape directly:

```bash
pnpm run runtime:matrix -- --model claude-sonnet-4.6
pnpm run runtime:probe -- --shape both --model claude-sonnet-4.6 --prompt "Reply with exactly: OK"
pnpm run runtime:probe -- --shape both --model claude-sonnet-4.6 --thinking --prompt "Reply with exactly: OK"
pnpm run runtime:probe -- --shape both --model claude-sonnet-4.6 --tools 1 --prompt "Use smoke_tool_0 with value ping. Do not answer directly."
```

By default `runtime:probe` uses `--expect current`: generated service `camelCase` payloads must return `200`, while Kiro CLI recording-like `snake_case` payloads must be rejected with `400 REQUEST_BODY_INVALID`. That makes the command pass when the runtime behavior matches the known safe shape. Use `--expect all-ok` only when deliberately testing whether a rejected shape has started working.

`runtime:matrix` runs the baseline probe set used by this repo: plain text,
thinking, direct tool-use wire shape, Anthropic/OpenAI proxy smoke, streaming
for both API surfaces, proxy smoke with `81` tools, and a full
`tool_use -> tool_result -> end_turn` roundtrip.

To test the full proxy path against live Kiro runtime after building:

```bash
pnpm build
pnpm run runtime:smoke -- --model claude-sonnet-4.6
pnpm run runtime:smoke -- --model claude-sonnet-4.6 --tools 81
pnpm run runtime:roundtrip -- --model claude-sonnet-4.6
```

These send live requests through the local proxy and may consume Kiro quota. `runtime:roundtrip` verifies the complete Anthropic tool flow: model emits `tool_use`, the client sends `tool_result`, and the model returns a final `end_turn` response.

## Compatibility

| Surface | Scope | Status | Verification |
|---------|-------|--------|--------------|
| Claude Code | Anthropic `POST /v1/messages` | Tested live | `runtime:smoke`, `runtime:roundtrip` |
| Codex | OpenAI `POST /v1/chat/completions` | Tested live | `runtime:smoke --api openai` |
| Streaming | SSE response translation for Anthropic and OpenAI | Tested live | `runtime:smoke --stream`, `runtime:smoke --api openai --stream` |
| Thinking | `additionalModelRequestFields.output_config.effort` | Tested live | `runtime:probe --thinking` |
| Tool use | assistant `tool_use` emission | Tested live | `runtime:probe --tools 1`, `runtime:smoke --tools 1` |
| Tool roundtrip | `tool_use -> tool_result -> final answer` | Tested live | `runtime:roundtrip` |
| Large tool count | Anthropic request with `81` tools | Tested live | `runtime:smoke --tools 81` |
| Kiro CLI trace drift | snake_case trace vs camelCase wire shape | Tested live | `runtime:probe --shape both` |

The compatibility table is intentionally narrow: entries only move to
`Tested live` once they are covered by the runtime probe or smoke scripts.

Known live gap:

- Image input is implemented in the Anthropic translator and validated locally,
  but the current live Kiro runtime path still rejects the request with `400`.
  Keep it out of `Tested live` until the exact upstream shape is confirmed.

### Release maintenance

```bash
pnpm release:check
pnpm release:prepare -- patch
pnpm release:notes -- 2.1.0
```

Use `release:check` before tagging, `release:prepare` to bump
`package.json` and roll the current `Unreleased` changelog into a release
entry, and `release:notes` to render the exact GitHub release body from
`CHANGELOG.md`.

Security defaults:

- Binds to `127.0.0.1` by default.
- Refuses non-local `--host` unless `--api-key` / `KIROLINK_API_KEY` is set.
- Limits JSON request bodies via `KIROLINK_MAX_BODY_BYTES`.
- Only reflects CORS for local browser origins.

## Supported Endpoints

| Endpoint | Format | Used by |
|----------|--------|---------|
| `POST /v1/messages` | Anthropic | Claude Code |
| `POST /v1/chat/completions` | OpenAI | Codex |
| `GET /v1/models` | Both | Model listing |
| `POST /v1/messages/count_tokens` | Anthropic | Token estimation |
| `GET /health` | — | Health check |

## Features

- ✅ Streaming (SSE)
- ✅ Tool use (tool_use blocks + function calling)
- ✅ Thinking/reasoning (effort levels)
- ✅ Image inputs
- ✅ Multi-turn conversation history
- ✅ All Claude model names (auto-mapped)
- ✅ Kiro's non-Claude models (`auto`, `minimax-m2.5`, `minimax-m2.1`, `qwen3-coder-next`)
- ✅ Auto token refresh (via `kiro-cli`)
- ✅ Payload field-level truncation (caps a single oversized field, never drops history)
- ✅ Context-window overflow reported as `context_length_exceeded` (client-driven `/compact`)
- ✅ Retry on rate limit (429)
- ✅ Request throttling
- ✅ Auto port fallback
- ✅ Quiet mode
- ✅ Background tray (macOS / Windows / Linux, headless fallback)
- ✅ Live web dashboard (status, credits, recent requests)
- ✅ First-run setup wizard + `doctor` diagnostics

## License

MIT
