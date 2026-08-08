/**
 * CLI help text.
 *
 * Kept out of cli.ts so the entry point stays about wiring, and so the
 * documented environment surface sits next to nothing else.
 */

export function renderHelp(configPath: string): string {
  return `kirolink — Anthropic & OpenAI compatible proxy backed by Kiro

Usage: kirolink [command] [options]

Commands:
  serve                       Start the proxy (default when no command is given)
  setup                       Interactive first-run configuration
  doctor                      Diagnose auth, credits, network, and port issues
  tray [start|stop|status|restart]
                              Run the proxy in the background with a tray icon
                              (menu-bar on macOS, notification-area on Windows,
                              AppIndicator/yad on Linux; headless if unavailable)

Options:
  -p, --port <port>           Listen port (default: 4119)
      --host <host>           Listen host (default: 127.0.0.1)
  -q, --quiet                 Hide request traces
  -v, --verbose               Show debug logs (token refresh, retries, timings)
      --json                  Emit newline-delimited JSON logs
      --max-concurrent <n>    Max concurrent Kiro API calls (default: 2)
      --delay <ms>            Delay between queued requests (default: 200)
      --api-key <key>         Require this key from clients (protects the proxy)
      --auth <cli|api-key>    Upstream auth mode (default: cli, remembered)
      --kiro-api-key <key>    Upstream Kiro API key (remembered)
      --api-region <region>   Kiro runtime region (remembered; default: us-east-1)
  -h, --help                  Show this help
      --version               Show version

Endpoints:
  GET  /                           Dashboard (status, credits, recent requests)
  POST /v1/messages                Anthropic Messages API
  POST /v1/chat/completions        OpenAI Chat Completions API
  POST /v1/messages/count_tokens   Token estimate (heuristic)
  GET  /v1/models                  Advertised model ids
  GET  /v1/status                  Machine-readable status JSON
  GET  /v1/usage  (or /credits)    Live quota JSON (?refresh=1 bypasses cache)
  GET  /health                     Liveness probe

Config file (auto-saved, mode 0600):
  ${configPath}
  Override the path with KIROLINK_CONFIG.

  Priority for auth/key/region: CLI flag > env var > saved config > default

Environment (KIROLINK_* is canonical; legacy KIRO_PROXY_* names still work):
  Server      KIROLINK_PORT, KIROLINK_HOST, KIROLINK_API_KEY,
              KIROLINK_MAX_BODY_BYTES
  Upstream    KIROLINK_AUTH, KIROLINK_KIRO_API_KEY, KIROLINK_API_REGION,
              KIROLINK_API_URL, KIROLINK_ALLOW_UNTRUSTED_API_URL,
              KIROLINK_TOKEN_PATH, KIROLINK_REQUEST_TIMEOUT_MS
  Throttle    KIROLINK_MAX_CONCURRENT, KIROLINK_DELAY_MS
  Limits      KIROLINK_MAX_TOOLS, KIROLINK_MAX_TOOL_SCHEMA_BYTES,
              KIROLINK_MAX_TOTAL_TOOL_SCHEMA_BYTES
  Translation KIROLINK_FILTER_SYSTEM_PROMPT, KIROLINK_INJECT_THINKING_PROMPT,
              KIROLINK_FORCE_THINKING_EFFORT, KIROLINK_THINKING_EFFORT,
              KIROLINK_RANDOM_CONVERSATION_ID
  Credits     KIROLINK_REQUIRE_CREDITS
  Diagnostics KIROLINK_LOG_JSON, KIROLINK_EXPOSE_UPSTREAM_ERRORS,
              KIROLINK_DUMP_FAILED_PAYLOAD, KIROLINK_FAILED_PAYLOAD_PATH
  Identity    KIROLINK_KIRO_CLI_VERSION, KIROLINK_USER_AGENT,
              KIROLINK_AMZ_USER_AGENT, KIROLINK_CODEWHISPERER_OPTOUT
  Config      KIROLINK_CONFIG, XDG_CONFIG_HOME

Upstream auth modes:
  cli       Use the kiro-cli login (its secret store, or ~/.aws/sso/cache/ for
            older builds and the Kiro IDE). Run: kiro-cli login
  api-key   Use a Kiro API key (Bearer + tokentype: API_KEY)

Examples:
  kirolink
  kirolink --auth api-key --kiro-api-key KEY --api-region eu-central-1
  kirolink --auth api-key                      # reuses saved key + region
  kirolink tray                                # background + tray icon
  kirolink tray status                         # is a background tray running?
  kirolink tray stop                           # stop the background tray

Claude Code:
  kirolink &
  ANTHROPIC_BASE_URL=http://127.0.0.1:4119 ANTHROPIC_AUTH_TOKEN=dummy claude
`
}
