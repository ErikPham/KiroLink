# KiroLink

Anthropic & OpenAI compatible proxy backed by Kiro. Works with **Claude Code** and **Codex**.

Reads auth from `kiro-cli` cache — no credentials to manage. Supports tool_use, thinking, streaming.

Maintainer docs:

- [CHANGELOG.md](./CHANGELOG.md)
- [RELEASING.md](./RELEASING.md)

## Prerequisites

**Required:** Install and login to [Kiro CLI](https://docs.kiro.dev/cli) first:

```bash
# Install Kiro CLI
# See https://docs.kiro.dev/cli for your platform

# Login (required before using KiroLink)
kiro-cli login
```

KiroLink reads the auth token that `kiro-cli` manages. Without it, the proxy cannot authenticate with Kiro API.

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

## Options

```
  -p, --port <port>           Listen port (default: 4119)
      --host <host>           Listen host (default: 127.0.0.1)
  -q, --quiet                 Hide request traces
      --max-concurrent <n>    Max concurrent Kiro API calls (default: 2)
      --delay <ms>            Delay between queued requests (default: 200)
      --api-key <key>         Require API key for clients
  -h, --help                  Show help
```

## Environment Variables

```
KIRO_PROXY_PORT=4119
KIRO_PROXY_HOST=127.0.0.1
KIRO_PROXY_API_KEY=your-key
KIRO_PROXY_MAX_CONCURRENT=2
KIRO_PROXY_DELAY_MS=200
KIRO_PROXY_MAX_BODY_BYTES=1048576
KIRO_PROXY_TOKEN_PATH=~/.aws/sso/cache/kiro-auth-token-cli.json
KIRO_PROXY_API_URL=https://runtime.us-east-1.kiro.dev/
KIRO_PROXY_ALLOW_UNTRUSTED_API_URL=0
KIRO_PROXY_CODEWHISPERER_OPTOUT=true
KIRO_PROXY_THINKING_EFFORT=low|medium|high|xhigh|max
KIRO_PROXY_FORCE_THINKING_EFFORT=0
KIRO_PROXY_FILTER_SYSTEM_PROMPT=0
KIRO_PROXY_INJECT_THINKING_PROMPT=0
KIRO_PROXY_MAX_TOOLS=256
KIRO_PROXY_MAX_TOOL_SCHEMA_BYTES=131072
KIRO_PROXY_MAX_TOTAL_TOOL_SCHEMA_BYTES=786432
KIRO_PROXY_DUMP_FAILED_PAYLOAD=0
KIRO_PROXY_FAILED_PAYLOAD_PATH=/tmp/kiro-failed-payload.json
```

## How it works

```
Claude Code ──→ /v1/messages ──→ KiroLink ──→ Kiro API
Codex ─────→ /v1/chat/completions ─┘              │
                                         ↕
                          ~/.aws/sso/cache/kiro-auth-token-cli.json
                                (managed by kiro-cli)
```

1. Reads token from `kiro-cli`'s auth cache (auto-refreshed via `kiro-cli` when expired)
2. Translates API requests → Kiro `generateAssistantResponse`
3. Parses AWS Event Stream binary response
4. Translates back to Anthropic/OpenAI format
5. Throttles concurrent requests to avoid rate limits

Runtime safety notes:

- `KIRO_PROXY_API_URL` must use `https`.
- API URL overrides are restricted to known Kiro runtime hosts unless `KIRO_PROXY_ALLOW_UNTRUSTED_API_URL=1` is set.
- API keys must be at least 16 bytes when configured.
- Thinking is sent through Kiro runtime `additionalModelRequestFields.output_config.effort` when the model supports it, not by prompt injection.
- CodeWhisperer data opt-out defaults to `true`; set `KIRO_PROXY_CODEWHISPERER_OPTOUT=false` only if you intentionally want to mirror that header differently.
- Claude/Codex system prompts are preserved by default. `KIRO_PROXY_FILTER_SYSTEM_PROMPT=1` and `KIRO_PROXY_INJECT_THINKING_PROMPT=1` are experimental opt-ins.
- Tool names, tool IDs, tool-result links, model IDs, image media types, output token limits, and schema sizes are validated before a request is sent to Kiro.
- Failed payload dumps are disabled by default because they may contain prompt or tool output data. Enable `KIRO_PROXY_DUMP_FAILED_PAYLOAD=1` only for local debugging.

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
- Refuses non-local `--host` unless `--api-key` / `KIRO_PROXY_API_KEY` is set.
- Limits JSON request bodies via `KIRO_PROXY_MAX_BODY_BYTES`.
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
- ✅ Auto token refresh (via `kiro-cli`)
- ✅ Payload truncation (large conversations)
- ✅ Retry on rate limit (429)
- ✅ Request throttling
- ✅ Auto port fallback
- ✅ Quiet mode

## License

MIT
