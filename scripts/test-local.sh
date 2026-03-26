#!/bin/zsh

set -euo pipefail

cleanup() {
  anchor run light-stop
}

trap cleanup EXIT INT TERM

anchor run light

export ANCHOR_PROVIDER_URL="http://127.0.0.1:8899"
export ANCHOR_WALLET="keys/taskforest.json"

npx ts-mocha -p ./tsconfig.json -t 1000000 tests/taskforest-payments.ts
npx ts-mocha -p ./tsconfig.json -t 120000 tests/compress-settlement.ts
