#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
INPUT=${1:-}
PROOF=${2:-"$ROOT/build/proof.json"}
PUBLIC=${3:-"$ROOT/build/public.json"}
SNARKJS="$ROOT/node_modules/.bin/snarkjs"
WASM="$ROOT/build/entros_hamming_js/entros_hamming.wasm"
ZKEY="$ROOT/build/entros_hamming_final.zkey"

if [ -z "$INPUT" ]; then
  echo "Usage: npm run prove -- <input.json> [proof.json] [public.json]" >&2
  exit 1
fi

for file in "$INPUT" "$SNARKJS" "$WASM" "$ZKEY"; do
  if [ ! -f "$file" ]; then
    echo "Required file is missing: $file" >&2
    exit 1
  fi
done

"$SNARKJS" groth16 fullprove "$INPUT" "$WASM" "$ZKEY" "$PROOF" "$PUBLIC"
