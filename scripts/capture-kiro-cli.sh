#!/usr/bin/env bash
#
# capture-kiro-cli.sh — Capture the exact request kiro-cli sends to the Kiro
# runtime API, so KiroLink can be kept byte-for-byte in sync with the official
# client (endpoint, headers, User-Agent, and request body shape).
#
# Requirements:
#   - mitmproxy (brew install mitmproxy)
#   - kiro-cli installed and logged in (kiro-cli login)
#
# Usage:
#   ./scripts/capture-kiro-cli.sh "your prompt here"
#
# Output:
#   - Prints request headers (Authorization redacted) to stdout
#   - Writes the full request body to /tmp/kiro-real-body.json
#
set -euo pipefail

PROMPT="${1:-say hi}"
PORT="${MITM_PORT:-8899}"
CA="$HOME/.mitmproxy/mitmproxy-ca-cert.pem"
ADDON="$(mktemp /tmp/kiro-capture-XXXX.py)"

cleanup() { rm -f "$ADDON"; [ -n "${MITM_PID:-}" ] && kill "$MITM_PID" 2>/dev/null || true; }
trap cleanup EXIT

cat > "$ADDON" <<'PY'
import json

def request(flow):
    if "runtime" in flow.request.host and "kiro.dev" in flow.request.host:
        print("\n========== KIRO REQUEST ==========")
        print(f"{flow.request.method} {flow.request.pretty_url}")
        print("--- HEADERS ---")
        for k, v in flow.request.headers.items():
            if k.lower() == "authorization":
                v = v[:16] + "...[redacted]"
            print(f"{k}: {v}")
        try:
            body = json.loads(flow.request.get_text())
            with open("/tmp/kiro-real-body.json", "w") as f:
                json.dump(body, f, indent=2)
            print("--- BODY written to /tmp/kiro-real-body.json ---")
        except Exception as e:
            print(f"--- BODY parse error: {e} ---")
        print("==================================\n")
PY

# Ensure mitmproxy CA exists
if [ ! -f "$CA" ]; then
  echo "Generating mitmproxy CA cert..."
  mitmdump --listen-port "$PORT" >/dev/null 2>&1 &
  sleep 3
  kill $! 2>/dev/null || true
fi

echo "Starting mitmdump on port $PORT..."
mitmdump --listen-port "$PORT" -s "$ADDON" -q &
MITM_PID=$!
sleep 3

echo "Running kiro-cli through proxy..."
echo "$PROMPT" | \
  HTTPS_PROXY="http://127.0.0.1:$PORT" \
  HTTP_PROXY="http://127.0.0.1:$PORT" \
  AWS_CA_BUNDLE="$CA" \
  SSL_CERT_FILE="$CA" \
  kiro-cli chat --no-interactive --model claude-sonnet-4.6 >/dev/null 2>&1 || true

sleep 2
echo ""
echo "Done. Full body at /tmp/kiro-real-body.json"
