#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PROOF=${1:-"$ROOT/build/proof.json"}
PUBLIC=${2:-"$ROOT/build/public.json"}
SNARKJS="$ROOT/node_modules/.bin/snarkjs"
ZKEY="$ROOT/build/entros_hamming_final.zkey"
TEMP_DIRECTORY=$(mktemp -d "${TMPDIR:-/tmp}/entros-local-vk.XXXXXX")
TEMP_VK="$TEMP_DIRECTORY/verification_key.json"

cleanup() {
  if [ -f "$TEMP_VK" ]; then
    unlink "$TEMP_VK"
  fi
  rmdir "$TEMP_DIRECTORY"
}
trap cleanup EXIT

for file in "$PROOF" "$PUBLIC" "$SNARKJS" "$ZKEY"; do
  if [ ! -f "$file" ]; then
    echo "Required file is missing: $file" >&2
    exit 1
  fi
done

"$SNARKJS" zkey export verificationkey "$ZKEY" "$TEMP_VK" >/dev/null
"$SNARKJS" groth16 verify "$TEMP_VK" "$PUBLIC" "$PROOF"
