#!/usr/bin/env bash
# Run the Playwright browser tests.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/playwright-env.sh

npm run build
node --test test/e2e/*.e2e.ts
