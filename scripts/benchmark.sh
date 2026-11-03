#!/usr/bin/env bash
# Run the tab-switch benchmark in a real browser. Arguments go to
# benchmark/tab-switch.ts, for example: npm run benchmark -- --preset long --cpu 4
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/playwright-env.sh

npm run build >/dev/null
node benchmark/tab-switch.ts "$@"
