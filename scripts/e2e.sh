#!/usr/bin/env bash
# Run the Playwright browser tests. On Nix systems the browsers come from the
# nixpkgs playwright-driver bundle (its version must match the npm playwright
# devDependency); elsewhere, `npx playwright install chromium` once and this
# script uses the default install location.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${PLAYWRIGHT_BROWSERS_PATH:-}" ] && command -v nix >/dev/null 2>&1; then
  # Each Playwright release looks for its own browser build, so a version
  # mismatch fails every test with "Executable doesn't exist".
  nix_version="$(nix eval --raw nixpkgs#playwright-driver.version)"
  npm_version="$(node -p "require('playwright/package.json').version")"
  if [ "$nix_version" != "$npm_version" ]; then
    echo "The Playwright browsers from nixpkgs are for version $nix_version, but the npm playwright package is $npm_version." >&2
    echo "Run: npm install --save-dev --save-exact playwright@$nix_version" >&2
    exit 1
  fi
  PLAYWRIGHT_BROWSERS_PATH="$(nix build --no-link --print-out-paths nixpkgs#playwright-driver.browsers)"
  export PLAYWRIGHT_BROWSERS_PATH
  export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
fi

npm run build
node --test test/e2e/*.e2e.ts
