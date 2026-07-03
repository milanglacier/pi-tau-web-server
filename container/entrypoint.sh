#!/usr/bin/env bash
set -euo pipefail

: "${TAU_USER:?TAU_USER must be set}"
: "${TAU_PASS:?TAU_PASS must be set}"
: "${PI_CODING_AGENT_DIR:=/state/agent}"

mkdir -p \
  "$PI_CODING_AGENT_DIR" \
  "${HOME:-/state/home}"

# Credentials remain environment-only. On the first container start for an
# instance, remove any copied Tau credentials and enable the existing Basic
# Auth implementation. Later Pi/Tau settings changes are left untouched.
state_dir="$(dirname -- "$PI_CODING_AGENT_DIR")"
auth_marker="$state_dir/.tau-auth-initialized"
if [[ ! -e "$auth_marker" ]]; then
  node - "$PI_CODING_AGENT_DIR/settings.json" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const settingsPath = process.argv[2];
let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
} catch {}

if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {};
if (!settings.tau || typeof settings.tau !== 'object' || Array.isArray(settings.tau)) settings.tau = {};
delete settings.tau.user;
delete settings.tau.pass;
settings.tau.authEnabled = true;

fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
const temporaryPath = `${settingsPath}.tmp`;
fs.writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporaryPath, settingsPath);
NODE
  touch "$auth_marker"
fi

exec "$@"
