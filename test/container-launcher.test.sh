#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT

export HOME="$TMP/home"
export TAU_CONTAINER_STATE_DIR="$TMP/state"
export PI_CODING_AGENT_DIR="$TMP/pi-agent"

mkdir -p \
  "$HOME" \
  "$PI_CODING_AGENT_DIR/sessions/project" \
  "$PI_CODING_AGENT_DIR/npm/package" \
  "$PI_CODING_AGENT_DIR/git/package"
printf '{"packages":["npm:example-package"],"tau":{"authEnabled":false}}\n' \
  >"$PI_CODING_AGENT_DIR/settings.json"
printf 'host history\n' >"$PI_CODING_AGENT_DIR/sessions/project/history.jsonl"
printf 'host npm payload\n' >"$PI_CODING_AGENT_DIR/npm/package/index.js"
printf 'host git payload\n' >"$PI_CODING_AGENT_DIR/git/package/index.js"
printf 'dereferenced\n' >"$TMP/external-config"
ln -s "$TMP/external-config" "$PI_CODING_AGENT_DIR/external-config"

# shellcheck disable=SC1091
source "$ROOT/container/tau-container"

seed_configuration alpha

alpha="$TAU_CONTAINER_STATE_DIR/alpha"
test -f "$alpha/agent/settings.json"
test -f "$alpha/agent/external-config"
test ! -L "$alpha/agent/external-config"
test "$(cat "$alpha/agent/external-config")" = 'dereferenced'
test -d "$alpha/agent/sessions"
test ! -e "$alpha/agent/npm"
test ! -e "$alpha/agent/git"
test -d "$alpha/projects/chat"

printf 'instance-owned change\n' >"$alpha/agent/settings.json"
printf 'project data\n' >"$alpha/projects/keep.txt"
rmdir "$alpha/projects/chat"
seed_configuration alpha
test "$(cat "$alpha/agent/settings.json")" = 'instance-owned change'
test "$(cat "$alpha/projects/keep.txt")" = 'project data'
test -d "$alpha/projects/chat"

seed_configuration beta
test -f "$TAU_CONTAINER_STATE_DIR/beta/agent/settings.json"
test "$(cat "$TAU_CONTAINER_STATE_DIR/beta/agent/settings.json")" != 'instance-owned change'
test -d "$TAU_CONTAINER_STATE_DIR/beta/projects/chat"

CAPTURED_RUNTIME_ARGS=()
fake_container_runtime() {
  if [[ "$1" == run ]]; then
    CAPTURED_RUNTIME_ARGS=("$@")
  fi
  return 0
}

export TAU_CONTAINER_RUNTIME=fake_container_runtime
export TAU_USER=alice
export TAU_PASS=secret
run_instance gamma --bind 127.0.0.1 --foreground

runtime_args="$(printf '%s\n' "${CAPTURED_RUNTIME_ARGS[@]}")"
test "$(printf '%s\n' "$runtime_args" | grep -Fxc 'TAU_PROJECTS_DIR=/state/home/projects')" -eq 1
# Do not set PI_CODING_AGENT_SESSION_DIR here. Pi's default session directory
# under PI_CODING_AGENT_DIR preserves the per-project layout that Tau scans for
# sidebar history; overriding it to /state/sessions made the sidebar empty.
test "$(printf '%s\n' "$runtime_args" | grep -Fc 'PI_CODING_AGENT_SESSION_DIR=')" -eq 0
test "$(printf '%s\n' "$runtime_args" | grep -Fxc "$TAU_CONTAINER_STATE_DIR/gamma/projects:/state/home/projects:rw")" -eq 1
test "$(printf '%s\n' "$runtime_args" | grep -Fc '/workspace')" -eq 0
test "$(printf '%s\n' "$runtime_args" | grep -Fxc "$REPOSITORY_ROOT")" -eq 0

entry_state="$TMP/entry-state"
mkdir -p "$entry_state/agent" "$entry_state/home"
cp "$PI_CODING_AGENT_DIR/settings.json" "$entry_state/agent/settings.json"
TAU_USER=alice \
TAU_PASS=secret \
HOME="$entry_state/home" \
PI_CODING_AGENT_DIR="$entry_state/agent" \
  "$ROOT/container/entrypoint.sh" true

node - "$entry_state/agent/settings.json" <<'NODE'
const fs = require('node:fs');
const settings = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (settings.tau.authEnabled !== true) throw new Error('auth was not enabled');
if ('user' in settings.tau || 'pass' in settings.tau) throw new Error('credentials were persisted');
NODE

node - "$entry_state/agent/settings.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
settings.tau.authEnabled = false;
fs.writeFileSync(file, JSON.stringify(settings));
NODE

TAU_USER=alice \
TAU_PASS=secret \
HOME="$entry_state/home" \
PI_CODING_AGENT_DIR="$entry_state/agent" \
  "$ROOT/container/entrypoint.sh" true

node - "$entry_state/agent/settings.json" <<'NODE'
const fs = require('node:fs');
const settings = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (settings.tau.authEnabled !== false) throw new Error('persisted auth change was overwritten');
NODE

printf 'container launcher tests passed\n'
