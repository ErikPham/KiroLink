# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/) and
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Live runtime probe script for validating generated `camelCase` payloads
  against Kiro CLI recording-like `snake_case` payloads
- Proxy roundtrip smoke test for `tool_use -> tool_result -> end_turn`
- Release maintenance scripts for verification, changelog rendering, and
  release preparation
- Maintainer release workflow documentation and GitHub release notes automation

### Changed

- Thinking now uses `additionalModelRequestFields.output_config.effort`
  instead of relying on prompt injection by default
- System prompt filtering and thinking prompt injection are opt-in only
- Tool name sanitization now preserves response mapping and validates
  collisions more strictly
- Runtime verification docs now distinguish trace drift from true wire-shape
  compatibility

### Fixed

- Anthropic requests with more than 64 tools are accepted and translated
  safely for Kiro runtime
- Tool-use history now maps sanitized names correctly on follow-up requests
- Fresh conversation IDs are generated per request instead of reusing a
  process-wide value

## [1.0.0] - 2026-06-15

Initial release.

### Features
- Anthropic-compatible `POST /v1/messages` (streaming + non-stream)
- OpenAI-compatible `POST /v1/chat/completions` (streaming + non-stream)
- `GET /v1/models`, `POST /v1/messages/count_tokens`, `GET /health`
- Tool use (function calling) with name sanitization for MCP-style names
- Thinking / reasoning support
- Image input passthrough
- Auto token refresh via `kiro-cli`
- Request throttling (concurrency + delay) to avoid rate limits
- Auto port fallback when the chosen port is in use

### Security
- Binds to `127.0.0.1` by default; refuses non-local host without an API key
- Local-only CORS reflection
- Request body size limit
- API URL host allowlist

### Compatibility
- Uses the generated Kiro runtime service shape and headers observed from
  `kiro-cli`, while validating trace drift separately from live runtime
  compatibility.
