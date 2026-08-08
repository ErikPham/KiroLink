# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/) and
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

### Changed

### Fixed

## [1.1.0] - 2026-08-08

### Added
- **Background tray.** `kirolink tray` runs the proxy detached with a native
  status icon — menu-bar on macOS (compiled Swift/AppKit), notification-area on
  Windows (PowerShell/WinForms), AppIndicator or yad on Linux. The menu shows
  status, credits, and request count and offers open-dashboard, copy-URL,
  restart, stop, and quit; low-credit desktop notifications fire once per
  episode. Falls back to headless supervision (no icon) when no backend is
  present, so the proxy always runs. `tray status` / `tray stop` control it from
  any terminal via a pid + state file
- **First-run setup wizard.** `kirolink setup` (and an automatic prompt on a
  first `serve` in api-key mode with no key) walks through auth mode, key entry
  (masked), and region, then saves the config with mode `0600`
- **`doctor` command.** `kirolink doctor` checks auth/credentials, credits,
  network reachability, and port availability, printing a column-aligned report
  and exiting non-zero when unhealthy
- **Web dashboard.** The base URL now serves a live dashboard (dark/light) with
  status, credits, a copy-base-URL button, and a recent-requests table, backed by
  `GET /v1/status` JSON
- **Library entry point.** The package now exposes an embeddable API
  (`createKiroLink`, `loadConfig`, and the protocol/transport contracts) with
  TypeScript declarations, alongside the existing CLI. See README and
  `ARCHITECTURE.md`
- **`KiroClient` seam.** The upstream is an injectable interface, so the full chat
  path — SSE framing, error mapping, abort propagation, context-overflow
  translation — is testable. Test count grew from 114 to 315
- **`ProtocolAdapter` contract.** Client protocols are pluggable: an adapter owns
  validation, translation, and response writing, while the router and event pump
  are shared. Adding a protocol no longer means copying both
- Injectable `Logger` port with optional newline-delimited JSON output
  (`--json` / `KIROLINK_LOG_JSON=1`)
- `--version` flag
- SSE keepalive comment frames, so a long thinking phase does not trip
  intermediary idle timeouts
- 405 responses for a known path with the wrong method (previously 404)
- `ARCHITECTURE.md`, `CONTRIBUTING.md`, issue and PR templates
- oxlint in CI (`pnpm lint`, part of `pnpm release:check`)

### Fixed
- **`cli` mode could not find a kiro-cli 2.x login.** kiro-cli no longer writes
  its token to `~/.aws/sso/cache`; it keeps it in a secret store — the OS keyring,
  mirrored into an `auth_kv` table in its SQLite database — serialized in
  snake_case. Both stores are now read and the later expiry wins, so a machine
  carrying a kiro-cli token *and* an older Kiro IDE token uses whichever is
  actually fresh. Reading needs no new dependency: `security(1)` on macOS, and
  `node:sqlite` behind a dynamic import that degrades to "not logged in" on
  Node 18. `doctor` now names the store the token came from
- **Environment overrides were written back to the config file.** `serve`
  persisted the *resolved* auth mode, key, and region, so a one-off
  `KIROLINK_AUTH=cli kirolink` silently made `cli` the permanent default, and a
  `KIROLINK_KIRO_API_KEY` meant only for that process was copied to disk. Only
  the flags are documented as "remembered"; env-derived values are now used for
  the run and left unsaved
- **Infinite retry loop on port fallback.** When the requested port *and* the next
  one were both busy, the CLI retried the same port forever, spinning the CPU with
  no output and never exiting. Attempts now advance and are bounded
- **Upstream failures could return an empty `200`.** Introduced and caught by the
  new end-to-end tests during this refactor
- **Double truncation corrupted oversized tool results.** Two truncation passes
  with different limits (128KB then 64KB) meant the second cut through the first
  one's marker, destroying the `original_bytes` diagnostic. Truncation now happens
  once
- Malformed request fields (e.g. `tools: 42`) returned `500`; they now return `400`
- Client API keys are compared in constant time
- SSE writes respect backpressure, so a slow client no longer causes unbounded
  memory growth
- `uncaughtException` no longer loops silently forever; the process drains and
  exits non-zero so a supervisor can restart it

### Changed
- **Environment variables are now `KIROLINK_*`.** Every legacy `KIRO_PROXY_*` name
  is still read, so existing setups keep working; the canonical name wins when both
  are set
- Configuration is resolved once into an immutable `KiroLinkConfig` and passed
  explicitly. Resolved values are no longer written back into `process.env`, which
  previously leaked credentials into spawned child processes
- All mutable state (token cache, usage cache, throttle queue, conversation-id
  cache) is instance-scoped, so two instances can coexist in one process
- Errors carry their own HTTP status and API error type instead of being
  dispatched by comparing `error.message` against string literals
- Restructured into layers: `domain/`, `config/`, `logging/`, `kiro/`,
  `protocol/`, `http/`, with a single composition root in `app.ts`. The previous
  `kiro-api.ts` hub and its import cycles are gone
- The model registry moved out of the HTTP router into `domain/models.ts`
- `bin` now points at `dist/cli.js`; the build no longer patches in a shebang
- `truncatePayload` no longer drops conversation history to fit a size budget;
  it only caps a single oversized field (message content or tool result text).
  KiroLink forwards conversation history as given, matching how Kiro CLI itself
  does not discard turns to fit a budget

### Upstream auth (earlier in this cycle)
- Explicit upstream auth mode via `--auth` / `KIROLINK_AUTH` (`cli` | `api-key`,
  default **`cli`**)
- Upstream **Kiro API key** auth (`--auth api-key` + `--kiro-api-key`):
  `Authorization: Bearer <key>` + `tokentype: API_KEY`, no OAuth refresh and no
  `profileArn` required (aligned with Kiro-Go api_key credential support)
- Persist `auth` / `kiroApiKey` / `apiRegion` to `~/.config/kirolink/config.json`
  (mode `0600`; override with `KIROLINK_CONFIG`). Priority: CLI > env > file > default
- `--api-region` / `KIROLINK_API_REGION` to retarget the default runtime host when
  `KIROLINK_API_URL` is unset (e.g. `eu-central-1` → `runtime.eu-central-1.kiro.dev`)
- Startup log prints selected auth mode (`auth=cli …` or `auth=api-key …`)
- Remaining **Kiro credits** check via `getUsageLimits` (startup line +
  `GET /v1/usage` / `/credits`; optional `KIROLINK_REQUIRE_CREDITS=1` to reject
  chat when exhausted)
- Allowlist match for regional Kiro / Q / CodeWhisperer hosts (not only us-east-1)
- Support for Kiro's non-Claude models (`auto`, `minimax-m2.5`, `minimax-m2.1`,
  `qwen3-coder-next`), verified live against the Kiro runtime; listed in
  `GET /v1/models`. `glm-5` and `deepseek-3.2` are listed by
  `kiro-cli chat --list-models` but currently rejected by the Kiro runtime
  itself ("Invalid model ID") and are intentionally not yet supported
- Context-window / oversized-request errors from Kiro (`REQUEST_BODY_INVALID`,
  `ContextWindowOverflow`) are translated into the canonical
  `context_length_exceeded` error shape so Claude Code and Codex can trigger
  their own compaction, instead of being surfaced as a generic upstream failure

## [1.0.0] - 2026-07-15

First public release of KiroLink — an Anthropic- and OpenAI-compatible proxy
backed by the Kiro runtime.

### Features
- Anthropic-compatible `POST /v1/messages` (streaming + non-stream)
- OpenAI-compatible `POST /v1/chat/completions` (streaming + non-stream)
- `GET /v1/models`, `POST /v1/messages/count_tokens`, `GET /health`
- Tool use (function calling) with name sanitization for MCP-style names
- Thinking / reasoning via `additionalModelRequestFields.output_config.effort`
- Image input passthrough, including images inside Anthropic `tool_result` blocks
- Auto token refresh via `kiro-cli`
- Request throttling (concurrency + delay) to avoid rate limits
- Auto port fallback when the chosen port is in use
- Configurable runtime request timeout (`KIROLINK_REQUEST_TIMEOUT_MS`, default 10m)
- Stable in-process conversation IDs for prefix-cache reuse (opt out with
  `KIROLINK_RANDOM_CONVERSATION_ID=1`)
- Abort upstream Kiro requests when the client disconnects
- Live runtime probe / smoke scripts and release maintenance tooling

### Fixed
- Anthropic requests with more than 64 tools are accepted and translated
  safely for Kiro runtime
- Tool-use history maps sanitized names correctly on follow-up requests
- Oversized tool results are truncated instead of rejecting the request
- Claude Code `AskUserQuestion` inputs get stable `id` fields
- History wire shape closer to Kiro CLI (omit empty context / `envState` on
  past turns; keep tool-result images across multi-turn history)
- CI/Publish: resolve pnpm solely from `package.json` `packageManager`
- Flaky Node 18 body-size server test timeout

### Security
- Binds to `127.0.0.1` by default; refuses non-local host without an API key
- Local-only CORS reflection
- Request body size limit
- API URL host allowlist

### Compatibility
- Uses the generated Kiro runtime service shape and headers observed from
  `kiro-cli`, while validating trace drift separately from live runtime
  compatibility.
- System prompt filtering and thinking prompt injection are opt-in only
- Tool name sanitization preserves response mapping and validates collisions
  more strictly
