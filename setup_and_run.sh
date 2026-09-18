#!/usr/bin/env bash
# Check Python and launch the BASINGSTOKE·VIEW local console.
#
# Usage:
#   ./setup_and_run.sh                  # start the console at http://127.0.0.1:8123
#   ./setup_and_run.sh --port 9000      # use a different port
#   ./setup_and_run.sh --no-browser     # don't auto-open the browser
#   ./setup_and_run.sh rebuild-data     # re-fetch terrain/roads/rail/places/... (needs rasterio)
#   ./setup_and_run.sh rebuild-tles     # refresh the frozen satellite catalogue snapshot
#
# Set PYTHON_BIN to pick a specific interpreter; BASINGSTOKE_PORT sets the
# default port (overridden by --port). No pip packages are needed to run —
# server.py and the app itself are pure stdlib / vanilla JS.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

PORT="${BASINGSTOKE_PORT:-8123}"
OPEN_BROWSER=1
CMD="run"

while [ "$#" -gt 0 ]; do
    case "$1" in
        rebuild-data|rebuild-tles) CMD="$1" ;;
        --no-browser) OPEN_BROWSER=0 ;;
        --port)
            if [ "$#" -lt 2 ]; then echo "ERROR: --port needs a value" >&2; exit 2; fi
            PORT="$2"; shift ;;
        --help|-h)
            sed -n '2,10p' "$0"
            exit 0 ;;
        *) echo "Unknown option: $1 (use --help)" >&2; exit 2 ;;
    esac
    shift
done

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    echo "ERROR: --port must be between 1 and 65535" >&2; exit 2
fi

check_python() {
    "$1" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null
}

PYTHON_BIN="${PYTHON_BIN:-}"
if [ -n "$PYTHON_BIN" ]; then
    if ! check_python "$PYTHON_BIN"; then
        echo "ERROR: PYTHON_BIN must point to Python 3.9+." >&2; exit 1
    fi
else
    for candidate in python3 python; do
        if command -v "$candidate" >/dev/null 2>&1 && check_python "$candidate"; then
            PYTHON_BIN="$candidate"; break
        fi
    done
    if [ -z "$PYTHON_BIN" ]; then
        echo "ERROR: Install Python 3.9+ or set PYTHON_BIN." >&2; exit 1
    fi
fi
echo "==> Using $PYTHON_BIN ($("$PYTHON_BIN" --version 2>&1))"

case "$CMD" in
    rebuild-data)
        echo "==> Rebuilding terrain/roads/rail/places/towers/water/admin layers (needs: pip3 install rasterio)"
        exec "$PYTHON_BIN" scripts/fetch_data.py
        ;;
    rebuild-tles)
        echo "==> Refreshing the frozen satellite catalogue snapshot"
        exec "$PYTHON_BIN" scripts/build_tles.py
        ;;
esac

echo "==> No pip dependencies required for the console — pure stdlib server + vanilla JS front end."

# A server.py from an earlier run can survive the terminal that started it and
# keep holding the port, which makes a fresh start fail with "Address already
# in use". Clear it first — but only a process whose executable is python AND
# whose command line is this project's server.py, so nothing unrelated on the
# port is ever touched.
stale_server_pids() {
    local pid comm
    for pid in $(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true); do
        [ "$pid" = "$$" ] && continue
        comm="$(ps -o comm= -p "$pid" 2>/dev/null || true)"
        case "${comm##*/}" in
            python | python[0-9]*)
                if ps -o args= -p "$pid" 2>/dev/null | grep -q "server\.py"; then
                    printf '%s\n' "$pid"
                fi
                ;;
        esac
    done
}
STALE_PIDS="$(stale_server_pids)"
if [ -n "$STALE_PIDS" ]; then
    echo "==> Clearing stale server.py on port $PORT (pid $STALE_PIDS)"
    kill $STALE_PIDS 2>/dev/null || true
    sleep 0.5
fi

if [ "$OPEN_BROWSER" -eq 1 ] && command -v open >/dev/null 2>&1; then
    (
        for _ in $(seq 1 40); do
            "$PYTHON_BIN" -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:$PORT/', timeout=0.5)" >/dev/null 2>&1 && break
            sleep 0.25
        done
        open "http://127.0.0.1:$PORT/"
    ) &
fi

exec "$PYTHON_BIN" server.py "$PORT"
