#!/usr/bin/env bash
set -euo pipefail

APP_BIN="${KIRO_DESKTOP_BIN:-/Applications/Kiro CLI.app/Contents/MacOS/kiro_cli_desktop}"
APP_ID="${KIRO_DESKTOP_APP_ID:-com.amazon.codewhisperer}"
PORT="${MITM_PORT:-8899}"
OUT_DIR=""
IMAGE_PATH=""
PROMPT="Describe the pasted image in exactly one word."
AUTO_PASTE=1
LAUNCH_DELAY="${KIRO_CAPTURE_LAUNCH_DELAY:-6}"
CA="$HOME/.mitmproxy/mitmproxy-ca-cert.pem"
ADDON=""
MITM_PID=""
APP_PID=""

usage() {
  cat <<'EOF'
Usage: ./scripts/capture-kiro-desktop-image.sh --image <path> [options]

Capture the exact Kiro desktop runtime request produced by image paste.

Options:
  --image <path>      PNG/JPEG/GIF/TIFF file to copy into the clipboard
  --prompt <text>     Prompt to send after pasting the image
  --out <dir>         Output directory (default: /tmp/kiro-desktop-capture-<ts>)
  --port <port>       mitmproxy listen port (default: 8899)
  --manual            Do not auto-paste or auto-submit; only launch capture and set clipboard
  --delay <seconds>   Seconds to wait before UI automation (default: 6)
  -h, --help          Show this help

Output:
  request-*.json      Parsed runtime request bodies
  request-*.headers   Request headers with Authorization redacted
  response-*.json     Parsed JSON responses when possible
  response-*.txt      Raw response body when JSON parsing fails
  mitm.log            mitmdump stdout/stderr

Notes:
  - Requires mitmproxy and macOS Accessibility permissions for osascript UI automation.
  - Launches the desktop app through a local HTTPS proxy with the mitm CA bundle injected.
EOF
}

cleanup() {
  if [ -n "$MITM_PID" ]; then
    kill "$MITM_PID" 2>/dev/null || true
  fi
  if [ -n "$ADDON" ]; then
    rm -f "$ADDON"
  fi
}
trap cleanup EXIT

clipboard_class_for_image() {
  local lower
  lower="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "$lower" in
    *.png) printf '«class PNGf»' ;;
    *.jpg|*.jpeg) printf 'JPEG picture' ;;
    *.gif) printf 'GIF picture' ;;
    *.tif|*.tiff) printf 'TIFF picture' ;;
    *)
      printf 'Unsupported image extension for clipboard automation: %s\n' "$1" >&2
      exit 1
      ;;
  esac
}

if [ "${1:-}" = "--" ]; then
  shift
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --image)
      IMAGE_PATH="${2:-}"
      shift 2
      ;;
    --prompt)
      PROMPT="${2:-}"
      shift 2
      ;;
    --out)
      OUT_DIR="${2:-}"
      shift 2
      ;;
    --port)
      PORT="${2:-}"
      shift 2
      ;;
    --manual)
      AUTO_PASTE=0
      shift
      ;;
    --delay)
      LAUNCH_DELAY="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

[ -n "$IMAGE_PATH" ] || { printf '--image is required\n' >&2; usage >&2; exit 1; }
[ -f "$IMAGE_PATH" ] || { printf 'Image not found: %s\n' "$IMAGE_PATH" >&2; exit 1; }
[ -x "$APP_BIN" ] || { printf 'Desktop binary not found or not executable: %s\n' "$APP_BIN" >&2; exit 1; }

OUT_DIR="${OUT_DIR:-/tmp/kiro-desktop-capture-$(date +%s)}"
mkdir -p "$OUT_DIR"

ADDON="$(mktemp /tmp/kiro-desktop-capture-XXXX.py)"
cat >"$ADDON" <<'PY'
import json
import os
from pathlib import Path

OUT_DIR = Path(os.environ["KIRO_CAPTURE_OUT_DIR"])
counter = 0

def _redacted_headers(headers):
    redacted = {}
    for key, value in headers.items():
        if key.lower() == "authorization":
            value = value[:16] + "...[redacted]"
        redacted[key] = value
    return redacted

def request(flow):
    global counter
    if "runtime" not in flow.request.host or "kiro.dev" not in flow.request.host:
        return
    counter += 1
    stem = OUT_DIR / f"request-{counter}"
    stem.with_suffix(".headers").write_text(
        "\n".join(f"{k}: {v}" for k, v in _redacted_headers(flow.request.headers).items()) + "\n",
        encoding="utf-8",
    )
    try:
        body = json.loads(flow.request.get_text())
        stem.with_suffix(".json").write_text(json.dumps(body, indent=2), encoding="utf-8")
    except Exception as exc:
        stem.with_suffix(".txt").write_text(
            f"JSON parse error: {exc}\n\n{flow.request.get_text()}",
            encoding="utf-8",
        )

def response(flow):
    if "runtime" not in flow.request.host or "kiro.dev" not in flow.request.host:
        return
    stem = OUT_DIR / f"response-{counter}"
    try:
        body = json.loads(flow.response.get_text())
        stem.with_suffix(".json").write_text(json.dumps(body, indent=2), encoding="utf-8")
    except Exception:
        stem.with_suffix(".txt").write_text(flow.response.get_text(), encoding="utf-8")
PY

if [ ! -f "$CA" ]; then
  printf 'Generating mitmproxy CA cert...\n'
  mitmdump --listen-port "$PORT" >/dev/null 2>&1 &
  sleep 3
  kill "$!" 2>/dev/null || true
fi

printf 'Starting mitmdump on port %s...\n' "$PORT"
KIRO_CAPTURE_OUT_DIR="$OUT_DIR" mitmdump --listen-port "$PORT" -s "$ADDON" -q >"$OUT_DIR/mitm.log" 2>&1 &
MITM_PID="$!"
sleep 3

CLIP_CLASS="$(clipboard_class_for_image "$IMAGE_PATH")"
osascript -e "set the clipboard to (read (POSIX file \"$IMAGE_PATH\") as $CLIP_CLASS)" >/dev/null

printf 'Launching Kiro desktop through proxy...\n'
HTTPS_PROXY="http://127.0.0.1:$PORT" \
HTTP_PROXY="http://127.0.0.1:$PORT" \
AWS_CA_BUNDLE="$CA" \
SSL_CERT_FILE="$CA" \
"$APP_BIN" --allow-multiple --no-dashboard >"$OUT_DIR/desktop.log" 2>&1 &
APP_PID="$!"

if [ "$AUTO_PASTE" -eq 1 ]; then
  sleep "$LAUNCH_DELAY"
  KIRO_CAPTURE_PROMPT="$PROMPT" KIRO_CAPTURE_APP_ID="$APP_ID" osascript <<'OSA'
tell application id (system attribute "KIRO_CAPTURE_APP_ID") to activate
delay 2
tell application "System Events"
  keystroke "v" using command down
  delay 1
  keystroke (system attribute "KIRO_CAPTURE_PROMPT")
  delay 0.5
  key code 36
end tell
OSA
else
  printf 'Clipboard primed with image. Activate Kiro manually, paste the image, send the prompt, then press Ctrl-C when done.\n'
fi

printf 'Waiting for runtime request capture...\n'
for _ in $(seq 1 30); do
  if find "$OUT_DIR" -maxdepth 1 -name 'request-*.json' -o -name 'request-*.txt' | grep -q .; then
    break
  fi
  sleep 1
done

printf 'Capture output: %s\n' "$OUT_DIR"
find "$OUT_DIR" -maxdepth 1 \( -name 'request-*' -o -name 'response-*' -o -name '*.log' \) | sort
