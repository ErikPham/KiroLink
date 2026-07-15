# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/) and
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

### Changed

### Fixed

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
- Configurable runtime request timeout (`KIRO_PROXY_REQUEST_TIMEOUT_MS`, default 10m)
- Stable in-process conversation IDs for prefix-cache reuse (opt out with
  `KIRO_PROXY_RANDOM_CONVERSATION_ID=1`)
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
