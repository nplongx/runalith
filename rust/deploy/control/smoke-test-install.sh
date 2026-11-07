#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
RUST_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
BINARY_SOURCE="${1:-$RUST_ROOT/target/release/runalith-control}"
UNIT_SOURCE="$SCRIPT_DIR/runalith-control.service"

for command in install python3 systemd-analyze; do
  command -v "$command" >/dev/null 2>&1 || {
    printf 'missing required command: %s\n' "$command" >&2
    exit 2
  }
done
[[ -f "$BINARY_SOURCE" && -x "$BINARY_SOURCE" ]] || {
  printf 'release Control binary is missing or not executable: %s\n' "$BINARY_SOURCE" >&2
  printf 'build it with: cargo build --release --locked --offline -p runalith-control-api\n' >&2
  exit 2
}

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/runalith-control-install.XXXXXX")"
SERVER_PID=""
SYSTEMD_UNIT=""
cleanup() {
  if [[ -n "$SYSTEMD_UNIT" ]] && systemctl --user is-active --quiet "$SYSTEMD_UNIT" 2>/dev/null; then
    systemctl --user stop "$SYSTEMD_UNIT" >/dev/null 2>&1 || true
  fi
  if [[ -n "${SYSTEMD_STATE_DIR:-}" && -d "$SYSTEMD_STATE_DIR" ]]; then
    rm -rf -- "$SYSTEMD_STATE_DIR"
  fi
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -KILL "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf -- "$ROOT"
}
trap cleanup EXIT INT TERM

BIN_DIR="$ROOT/usr/local/bin"
STATE_DIR="$ROOT/var/lib/runalith-control"
RUNTIME_DIR="$ROOT/run/runalith-control"
ETC_DIR="$ROOT/etc/runalith"
mkdir -m 0700 -p "$BIN_DIR" "$STATE_DIR" "$RUNTIME_DIR" "$ETC_DIR"
install -m 0755 "$BINARY_SOURCE" "$BIN_DIR/runalith-control"
CONTROL_BIN="$BIN_DIR/runalith-control"

TOKEN="runalith-control-smoke-$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
WORKER_TOKEN="${TOKEN}-worker-smoke"
export TOKEN WORKER_TOKEN ROOT CONTROL_BIN STATE_DIR RUNTIME_DIR ETC_DIR UNIT_SOURCE
python3 <<'PY'
import hashlib
import json
import os
import pathlib
import pwd
import grp

root = pathlib.Path(os.environ["ROOT"])
binary = pathlib.Path(os.environ["CONTROL_BIN"])
state = pathlib.Path(os.environ["STATE_DIR"])
runtime = pathlib.Path(os.environ["RUNTIME_DIR"])
etc = pathlib.Path(os.environ["ETC_DIR"])
unit_source = pathlib.Path(os.environ["UNIT_SOURCE"])
token = os.environ["TOKEN"]
worker_token = os.environ["WORKER_TOKEN"]

auth = etc / "control-auth.json"
auth.write_text(json.dumps({
    "version": 1,
    "principals": [
        {
            "token_sha256": hashlib.sha256(token.encode()).hexdigest(),
            "subject": "install-smoke-operator",
            "issuer": "runalith-control-install-smoke-v1",
            "capabilities": ["control.health.read"],
        },
        {
            "token_sha256": hashlib.sha256(worker_token.encode()).hexdigest(),
            "subject": "install-smoke-worker",
            "issuer": "runalith-control-install-smoke-v1",
            "capabilities": ["worker.claim.receive"],
        },
    ],
}, separators=(",", ":")) + "\n")
auth.chmod(0o600)

# Find an unused loopback port without binding the service to a public address.
import socket
with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]

env_file = etc / "control.env"
env_file.write_text("\n".join([
    f"RUNALITH_CONTROL_DATABASE_PATH={state / 'workflow.db'}",
    f"RUNALITH_CONTROL_AUTH_FILE={auth}",
    f"RUNALITH_CONTROL_LISTEN_ADDR=127.0.0.1:{port}",
    f"RUNALITH_CONTROL_PID_FILE={runtime / 'control.pid'}",
    f"RUNALITH_CONTROL_SHUTDOWN_FILE={runtime / 'control.stop'}",
    "",
]))
env_file.chmod(0o600)
(root / "listen-port").write_text(str(port))

unit = unit_source.read_text()
unit = unit.replace("User=runalith-control", f"User={pwd.getpwuid(os.getuid()).pw_name}")
unit = unit.replace("Group=runalith-control", f"Group={grp.getgrgid(os.getgid()).gr_name}")
unit = unit.replace("EnvironmentFile=/etc/runalith/control.env", f"EnvironmentFile={env_file}")
unit = unit.replace("/usr/local/bin/runalith-control", str(binary))
unit = unit.replace("WorkingDirectory=/var/lib/runalith-control", f"WorkingDirectory={state}")
unit = unit.replace("ReadWritePaths=/var/lib/runalith-control /run/runalith-control", f"ReadWritePaths={state} {runtime}")
(root / "runalith-control.service").write_text(unit)
(root / "rendered-env-path").write_text(str(env_file))
PY

ENV_FILE="$(cat "$ROOT/rendered-env-path")"
set -a
# The generated env file contains only absolute paths and a loopback socket.
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

printf '%s\n' '[1/9] installed release binary'
"$CONTROL_BIN" version
"$CONTROL_BIN" --help >/dev/null

printf '%s\n' '[2/9] rendered systemd unit syntax/security'
systemd-analyze verify "$ROOT/runalith-control.service"
systemd-analyze security --offline=true "$ROOT/runalith-control.service" >"$ROOT/systemd-security.txt"
grep 'Overall exposure level' "$ROOT/systemd-security.txt"

printf '%s\n' '[3/9] initialized database and pre-start health'
"$CONTROL_BIN" init-db
"$CONTROL_BIN" health

printf '%s\n' '[4/9] invalid cold-restore snapshot is rejected without creating target'
INVALID_BACKUP="$STATE_DIR/invalid-restore.db"
FAILED_RESTORE_DB="$STATE_DIR/failed-restore.db"
printf '%s' 'not a SQLite database' >"$INVALID_BACKUP"
chmod 0600 "$INVALID_BACKUP"
if RUNALITH_CONTROL_DATABASE_PATH="$FAILED_RESTORE_DB" \
  RUNALITH_CONTROL_PID_FILE="$RUNTIME_DIR/failed-restore.pid" \
  "$CONTROL_BIN" restore-db "$INVALID_BACKUP" >"$ROOT/restore-failure.log" 2>&1; then
  printf '%s\n' 'invalid restore unexpectedly succeeded' >&2
  exit 1
fi
[[ ! -e "$FAILED_RESTORE_DB" ]]
[[ "$(cat "$INVALID_BACKUP")" == 'not a SQLite database' ]]

wait_ready() {
  python3 - "$RUNALITH_CONTROL_LISTEN_ADDR" <<'PY'
import json
import sys
import time
import urllib.error
import urllib.request

address = sys.argv[1]
url = f"http://{address}/readyz"
deadline = time.monotonic() + 10
last_error = None
while time.monotonic() < deadline:
    try:
        with urllib.request.urlopen(url, timeout=0.4) as response:
            body = json.load(response)
            if response.status == 200 and body.get("status") == "ready":
                raise SystemExit(0)
            last_error = f"unexpected readiness response: {response.status} {body}"
    except (OSError, urllib.error.URLError, ValueError) as error:
        last_error = str(error)
    time.sleep(0.05)
print(f"Control did not become ready: {last_error}", file=sys.stderr)
raise SystemExit(1)
PY
}

wait_authenticated_health() {
  python3 - "$RUNALITH_CONTROL_LISTEN_ADDR" "$TOKEN" <<'PY'
import json
import sys
import urllib.error
import urllib.request

url = f"http://{sys.argv[1]}/health"
request = urllib.request.Request(url, headers={"Authorization": f"Bearer {sys.argv[2]}"})
with urllib.request.urlopen(request, timeout=2) as response:
    body = json.load(response)
    assert response.status == 200, (response.status, body)
    assert body.get("service") == "runalith-control-api", body
    assert body.get("execution_dispatch") == "not_provided_by_control_api", body
PY
}

verify_worker_authority_fails_closed() {
  python3 - "$RUNALITH_CONTROL_LISTEN_ADDR" "$WORKER_TOKEN" <<'PY'
import json
import sys
import urllib.error
import urllib.request

url = f"http://{sys.argv[1]}/v1/worker/claims/receive"
request = urllib.request.Request(
    url,
    data=b'{"worker_id":"install-smoke-worker"}',
    headers={
        "Authorization": f"Bearer {sys.argv[2]}",
        "Content-Type": "application/json",
    },
    method="POST",
)
try:
    with urllib.request.urlopen(request, timeout=2) as response:
        body = json.load(response)
        raise AssertionError(f"worker claim route unexpectedly returned {response.status}: {body}")
except urllib.error.HTTPError as response:
    body = json.load(response)
    assert response.code == 503, (response.code, body)
    assert body.get("error") == "authoritative worker-control backend is not configured", body
PY
}

start_control() {
  "$CONTROL_BIN" serve >"$ROOT/serve.log" 2>&1 &
  SERVER_PID=$!
  wait_ready || {
    cat "$ROOT/serve.log" >&2
    return 1
  }
  wait_authenticated_health
}

stop_control() {
  "$CONTROL_BIN" stop
  wait "$SERVER_PID"
  SERVER_PID=""
  [[ ! -e "$RUNALITH_CONTROL_PID_FILE" ]]
}

printf '%s\n' '[5/9] startup, concurrent-start exclusion, probes, auth and worker fail-closed boundary'
start_control
FIRST_PID_MARKER="$(cat "$RUNALITH_CONTROL_PID_FILE")"
[[ -f "${RUNALITH_CONTROL_PID_FILE%.pid}.lock" ]]
if "$CONTROL_BIN" serve >"$ROOT/concurrent-serve.log" 2>&1; then
  printf '%s\n' 'concurrent Control startup unexpectedly succeeded' >&2
  exit 1
fi
grep -q 'another Control or maintenance process holds' "$ROOT/concurrent-serve.log"
[[ "$(cat "$RUNALITH_CONTROL_PID_FILE")" == "$FIRST_PID_MARKER" ]]
wait_ready
wait_authenticated_health
verify_worker_authority_fails_closed

printf '%s\n' '[6/9] SIGKILL crash and stale-PID restart recovery'
kill -KILL "$SERVER_PID"
  wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""
[[ -f "$RUNALITH_CONTROL_PID_FILE" ]]
start_control
SECOND_PID_MARKER="$(cat "$RUNALITH_CONTROL_PID_FILE")"
[[ "$FIRST_PID_MARKER" != "$SECOND_PID_MARKER" ]]

printf '%s\n' '[7/9] graceful stop and persistent database health'
stop_control
"$CONTROL_BIN" health

printf '%s\n' '[8/9] startup after graceful stop'
start_control
stop_control

if [[ -n "${XDG_RUNTIME_DIR:-}" ]] && command -v systemd-run >/dev/null 2>&1 \
  && systemctl --user is-system-running >/dev/null 2>&1; then
  printf '%s\n' '[9/9] transient systemd user-service activation, restart and graceful stop'
  SYSTEMD_STATE_DIR="$XDG_RUNTIME_DIR/runalith-control-smoke-$RANDOM-$$"
  SYSTEMD_UNIT="runalith-control-smoke-$RANDOM-$$.service"
  mkdir -m 0700 -p "$SYSTEMD_STATE_DIR"
  SYSTEMD_BINARY="$SYSTEMD_STATE_DIR/runalith-control"
  SYSTEMD_ENV_FILE="$SYSTEMD_STATE_DIR/control.env"
  install -m 0755 "$CONTROL_BIN" "$SYSTEMD_BINARY"
  python3 - "$SYSTEMD_STATE_DIR" "$TOKEN" <<'PY'
import hashlib
import json
import pathlib
import socket
import sys

root = pathlib.Path(sys.argv[1])
token = sys.argv[2]
with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
auth = root / "auth.json"
auth.write_text(json.dumps({
    "version": 1,
    "principals": [{
        "token_sha256": hashlib.sha256(token.encode()).hexdigest(),
        "subject": "systemd-smoke-operator",
        "issuer": "runalith-control-systemd-smoke-v1",
        "capabilities": ["control.health.read"],
    }],
}, separators=(",", ":")) + "\n")
auth.chmod(0o600)
env = root / "control.env"
env.write_text("\n".join([
    f"RUNALITH_CONTROL_DATABASE_PATH={root / 'workflow.db'}",
    f"RUNALITH_CONTROL_AUTH_FILE={auth}",
    f"RUNALITH_CONTROL_LISTEN_ADDR=127.0.0.1:{port}",
    f"RUNALITH_CONTROL_PID_FILE={root / 'control.pid'}",
    f"RUNALITH_CONTROL_SHUTDOWN_FILE={root / 'control.stop'}",
    "",
]))
env.chmod(0o600)
PY
  SYSTEMD_PID_FILE="$SYSTEMD_STATE_DIR/control.pid"
  RUNALITH_CONTROL_DATABASE_PATH="$SYSTEMD_STATE_DIR/workflow.db" \
    "$SYSTEMD_BINARY" init-db >/dev/null
  RUNALITH_CONTROL_DATABASE_PATH="$SYSTEMD_STATE_DIR/workflow.db" \
    "$SYSTEMD_BINARY" health >/dev/null
  SYSTEMD_PROPERTIES=(
    --property=Type=simple
    --property="EnvironmentFile=$SYSTEMD_ENV_FILE"
    --property="WorkingDirectory=$SYSTEMD_STATE_DIR"
    --property=UMask=0077
    --property=NoNewPrivileges=yes
    --property=ProtectSystem=strict
    --property=ProtectHome=yes
    --property=PrivateTmp=yes
    --property=ReadWritePaths="$SYSTEMD_STATE_DIR"
    --property=Restart=on-failure
    --property=RestartSec=1s
    --property="ExecStop=$SYSTEMD_BINARY stop"
    --property=TimeoutStopSec=35s
  )
  systemd-run --user --unit="$SYSTEMD_UNIT" --collect \
    "${SYSTEMD_PROPERTIES[@]}" "$SYSTEMD_BINARY" serve
  set -a
  # The service-specific env file contains only temporary absolute paths.
  # shellcheck disable=SC1090
  . "$SYSTEMD_ENV_FILE"
  set +a
  wait_ready
  wait_authenticated_health
  FIRST_SYSTEMD_PID="$(cat "$SYSTEMD_PID_FILE")"
  systemctl --user kill --kill-whom=main --signal=SIGKILL "$SYSTEMD_UNIT"
  wait_ready
  wait_authenticated_health
  CRASH_RECOVERED_SYSTEMD_PID="$(cat "$SYSTEMD_PID_FILE")"
  [[ "$FIRST_SYSTEMD_PID" != "$CRASH_RECOVERED_SYSTEMD_PID" ]]
  systemctl --user restart "$SYSTEMD_UNIT"
  wait_ready
  wait_authenticated_health
  CLEAN_RESTART_SYSTEMD_PID="$(cat "$SYSTEMD_PID_FILE")"
  [[ "$CRASH_RECOVERED_SYSTEMD_PID" != "$CLEAN_RESTART_SYSTEMD_PID" ]]
  systemctl --user stop "$SYSTEMD_UNIT"
  SYSTEMD_UNIT=""
  [[ ! -e "$SYSTEMD_PID_FILE" ]]
  "$SYSTEMD_BINARY" health >/dev/null
  rm -rf -- "$SYSTEMD_STATE_DIR"
  SYSTEMD_STATE_DIR=""
else
  printf '%s\n' 'SKIP: user systemd manager unavailable; rendered unit remains syntax/security-only evidence'
fi

printf '%s\n' 'PASS: temporary-prefix binary install, offline systemd verify/security, transient systemd activation/restart/stop when available, concurrent-start exclusion, invalid restore rejection, auth/readiness, worker fail-closed, SIGKILL recovery and database persistence'
