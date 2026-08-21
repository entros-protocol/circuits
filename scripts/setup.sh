#!/usr/bin/env bash
# The default mode creates local test artifacts under build/ and never changes keys/.
# Ceremony mode exports new verification keys after completing the documented ceremony.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

SNARKJS="$ROOT/node_modules/.bin/snarkjs"
LOCK_FILE="$ROOT/circuit-lock.json"
PTAU_FILE="$ROOT/build/pot12_final.ptau"

lock_value() {
  node -e 'const lock = require(process.argv[1]); const path = process.argv[2].split("."); let value = lock; for (const part of path) value = value[part]; process.stdout.write(String(value));' "$LOCK_FILE" "$1"
}

blake2b512() {
  if command -v b2sum >/dev/null 2>&1; then
    b2sum "$1" | awk '{print $1}'
    return
  fi
  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -blake2b512 "$1" | awk '{print $NF}'
    return
  fi
  echo "Error: install b2sum or OpenSSL to verify the Powers of Tau file." >&2
  return 1
}

MODE="test"
if [ "${1:-}" = "--ceremony" ]; then
  MODE="ceremony"
elif [ -n "${1:-}" ]; then
  echo "Unknown argument: $1 (use no args for a test build, or --ceremony)"
  exit 1
fi

echo "=== IAM Circuit Setup (mode: $MODE) ==="

if ! command -v circom &>/dev/null; then
  echo "Error: Circom is not installed." >&2
  exit 1
fi

EXPECTED_CIRCOM_VERSION=$(lock_value circom.version)
ACTUAL_CIRCOM_VERSION=$(circom --version | awk '{print $NF}')
if [ "$ACTUAL_CIRCOM_VERSION" != "$EXPECTED_CIRCOM_VERSION" ]; then
  echo "Error: expected Circom $EXPECTED_CIRCOM_VERSION, received $ACTUAL_CIRCOM_VERSION." >&2
  exit 1
fi

if [ ! -x "$SNARKJS" ]; then
  echo "Error: install locked npm dependencies with npm ci." >&2
  exit 1
fi

PTAU_URL=$(lock_value powersOfTau.url)
EXPECTED_PTAU_HASH=$(lock_value powersOfTau.blake2b512)
mkdir -p build

if [ -f "$PTAU_FILE" ]; then
  ACTUAL_PTAU_HASH=$(blake2b512 "$PTAU_FILE")
  if [ "$ACTUAL_PTAU_HASH" != "$EXPECTED_PTAU_HASH" ]; then
    echo "Error: the existing Powers of Tau file failed integrity verification." >&2
    exit 1
  fi
else
  echo "Downloading Hermez powers of tau..."
  DOWNLOAD_DIRECTORY=$(mktemp -d "${TMPDIR:-/tmp}/entros-ptau.XXXXXX")
  DOWNLOAD_FILE="$DOWNLOAD_DIRECTORY/pot12_final.ptau"
  cleanup_download() {
    if [ -f "$DOWNLOAD_FILE" ]; then
      unlink "$DOWNLOAD_FILE"
    fi
    rmdir "$DOWNLOAD_DIRECTORY"
  }
  trap cleanup_download EXIT

  curl --fail --location --proto '=https' --tlsv1.2 --output "$DOWNLOAD_FILE" "$PTAU_URL"
  ACTUAL_PTAU_HASH=$(blake2b512 "$DOWNLOAD_FILE")
  if [ "$ACTUAL_PTAU_HASH" != "$EXPECTED_PTAU_HASH" ]; then
    echo "Error: the downloaded Powers of Tau file failed integrity verification." >&2
    exit 1
  fi
  mv "$DOWNLOAD_FILE" "$PTAU_FILE"
  rmdir "$DOWNLOAD_DIRECTORY"
  trap - EXIT
fi

echo "Compiling circuit..."
circom circom/entros_hamming.circom \
  --r1cs --wasm --sym \
  --output build/ \
  -l node_modules/circomlib/circuits

echo "Constraint info:"
"$SNARKJS" r1cs info build/entros_hamming.r1cs

PTAU_MAX=4096
CONSTRAINT_COUNT=$(
  "$SNARKJS" r1cs info build/entros_hamming.r1cs 2>&1 |
    bash scripts/parse_constraint_count.sh
)
if [ -z "$CONSTRAINT_COUNT" ]; then
  echo "Error: could not parse the constraint count from 'snarkjs r1cs info'."
  exit 1
fi
if [ "$CONSTRAINT_COUNT" -gt "$PTAU_MAX" ]; then
  echo "Error: circuit has $CONSTRAINT_COUNT constraints but ptau supports max $PTAU_MAX (2^12)."
  echo "Use a larger Powers of Tau file."
  exit 1
fi
EXPECTED_CONSTRAINT_COUNT=$(lock_value artifacts.constraintCount)
if [ "$CONSTRAINT_COUNT" -ne "$EXPECTED_CONSTRAINT_COUNT" ]; then
  echo "Error: expected $EXPECTED_CONSTRAINT_COUNT constraints, received $CONSTRAINT_COUNT." >&2
  exit 1
fi
echo "Constraint check: $CONSTRAINT_COUNT <= $PTAU_MAX (ptau level 12) OK"

echo "Running Groth16 Phase 2 setup..."
"$SNARKJS" groth16 setup build/entros_hamming.r1cs build/pot12_final.ptau build/entros_hamming_0000.zkey

if [ "$MODE" = "test" ]; then
  echo "Test build: single local contribution (build/ only; keys/ untouched)..."
  "$SNARKJS" zkey contribute build/entros_hamming_0000.zkey build/entros_hamming_final.zkey \
    --name="local-test" -e="local-test-$(openssl rand -hex 8)"
  "$SNARKJS" zkey verify build/entros_hamming.r1cs build/pot12_final.ptau build/entros_hamming_final.zkey
  echo "=== Test build complete (keys/ unchanged) ==="
  echo "  Proving key: build/entros_hamming_final.zkey"
  echo "  WASM:        build/entros_hamming_js/entros_hamming.wasm"
  echo "  For PRODUCTION keys, run a real ceremony: scripts/setup.sh --ceremony (see CEREMONY.md)"
  exit 0
fi

CONTRIBUTORS="${CEREMONY_CONTRIBUTORS:-1}"
BEACON="${CEREMONY_BEACON:-}"
TRANSCRIPT="build/ceremony_transcript.txt"

echo "Phase-2 ceremony: $CONTRIBUTORS contributor(s)"
{
  echo "IAM Hamming circuit: Phase 2 ceremony transcript"
  echo "circuit:           circom/entros_hamming.circom"
  echo "r1cs constraints:  $CONSTRAINT_COUNT"
  echo "contributors:      $CONTRIBUTORS"
  echo "beacon:            ${BEACON:-<none>}"
  echo "----"
} > "$TRANSCRIPT"

PREV="build/entros_hamming_0000.zkey"
for i in $(seq 1 "$CONTRIBUTORS"); do
  NEXT="build/entros_hamming_$(printf '%04d' "$i").zkey"
  echo "Contribution $i/$CONTRIBUTORS..."
  echo "[contribution $i] contributor-$i" >> "$TRANSCRIPT"
  "$SNARKJS" zkey contribute "$PREV" "$NEXT" \
    --name="contributor-$i" -e="ceremony-$i-$(openssl rand -hex 16)" | tee -a "$TRANSCRIPT"
  PREV="$NEXT"
done

FINAL="build/entros_hamming_final.zkey"
if [ -n "$BEACON" ]; then
  echo "Applying public beacon finalization..."
  "$SNARKJS" zkey beacon "$PREV" "$FINAL" "$BEACON" 10 -n="final beacon" | tee -a "$TRANSCRIPT"
else
  cp "$PREV" "$FINAL"
fi

echo "Verifying final zkey against the r1cs + ptau..."
"$SNARKJS" zkey verify build/entros_hamming.r1cs build/pot12_final.ptau "$FINAL" | tee -a "$TRANSCRIPT"

echo "Exporting verification key to keys/ ..."
"$SNARKJS" zkey export verificationkey "$FINAL" keys/verification_key.json
node scripts/parse_vk_to_rust.js keys/verification_key.json keys/

echo "=== Ceremony complete ==="
echo "  Wrote:      keys/verification_key.json, keys/verifying_key.rs"
echo "  Transcript: $TRANSCRIPT"
echo "  NEXT: redeploy per CEREMONY.md: entros-verifier program upgrade (VK const),"
echo "        plus the mobile/mopro/web .zkey + wasm artifacts. Rotate out the old keys."
