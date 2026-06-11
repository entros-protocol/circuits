#!/usr/bin/env bash
# Trusted setup for the IAM Hamming circuit. Two modes:
#
#   (default)    Local/test build. Downloads ptau, compiles the circuit, and
#                generates a SINGLE-contributor proving key into build/ for
#                running the circuit tests. NEVER touches the committed keys in
#                keys/ — so `npm run setup` can't silently fork the production
#                verification key. (The prior script always overwrote
#                keys/verification_key.json + keys/verifying_key.rs on every
#                run, diverging local keys from the deployed on-chain VK.)
#
#   --ceremony   Multi-party Phase-2 ceremony. Initial setup, then one
#                `zkey contribute` per contributor (CEREMONY_CONTRIBUTORS,
#                default 1), optional public-beacon finalization, chain
#                verification, then export the VK to keys/ (JSON + Rust) and
#                write a transcript. This is the ONLY mode that writes keys/.
#                A 1-contributor run is the devnet path; the mainnet ceremony
#                runs >= 3 INDEPENDENT operators on separate air-gapped
#                machines per CEREMONY.md (this scripted loop is the mechanics
#                each operator runs / the dev+CI shape — real security comes
#                from non-colluding operators, not from this script).
set -euo pipefail

cd "$(dirname "$0")/.."

MODE="test"
if [ "${1:-}" = "--ceremony" ]; then
  MODE="ceremony"
elif [ -n "${1:-}" ]; then
  echo "Unknown argument: $1 (use no args for a test build, or --ceremony)"
  exit 1
fi

echo "=== IAM Circuit Setup (mode: $MODE) ==="

# 1. Check circom
if ! command -v circom &>/dev/null; then
  echo "Error: circom not installed. Run: cargo install --git https://github.com/iden3/circom.git"
  exit 1
fi

# 2. Download powers of tau if needed (Phase 1 — public Hermez ceremony, fine as-is)
if [ ! -f build/pot12_final.ptau ]; then
  echo "Downloading Hermez powers of tau..."
  mkdir -p build
  curl -L -o build/pot12_final.ptau \
    https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_12.ptau
fi

# 3. Compile circuit
echo "Compiling circuit..."
circom circom/entros_hamming.circom \
  --r1cs --wasm --sym \
  --output build/ \
  -l node_modules/circomlib/circuits

echo "Constraint info:"
npx snarkjs r1cs info build/entros_hamming.r1cs

# 3b. Verify constraint count fits within ptau level (2^12 = 4096 for pot12)
PTAU_MAX=4096
# Anchor to snarkjs's canonical "# of Constraints: N" line; fail loud if the
# count can't be parsed rather than silently skipping the guard (a no-match
# grep under `set -o pipefail` would otherwise leave CONSTRAINT_COUNT empty).
CONSTRAINT_COUNT=$(npx snarkjs r1cs info build/entros_hamming.r1cs 2>&1 | grep -iE '# of constraints' | grep -oE '[0-9]+' | head -1)
if [ -z "$CONSTRAINT_COUNT" ]; then
  echo "Error: could not parse the constraint count from 'snarkjs r1cs info'."
  exit 1
fi
if [ "$CONSTRAINT_COUNT" -gt "$PTAU_MAX" ]; then
  echo "Error: circuit has $CONSTRAINT_COUNT constraints but ptau supports max $PTAU_MAX (2^12)."
  echo "Use a larger ptau file (e.g., pot14_final.ptau for 2^14 = 16384)."
  exit 1
fi
echo "Constraint check: $CONSTRAINT_COUNT <= $PTAU_MAX (ptau level 12) ✓"

# 4. Phase 2 — initial setup (toxic-waste-bearing; both modes start here)
echo "Running Groth16 Phase 2 setup..."
npx snarkjs groth16 setup build/entros_hamming.r1cs build/pot12_final.ptau build/entros_hamming_0000.zkey

if [ "$MODE" = "test" ]; then
  # Single throwaway contribution → build/ only. NOT production: the entropy is
  # local and unattested. keys/ is deliberately left untouched.
  echo "Test build: single local contribution (build/ only; keys/ untouched)..."
  npx snarkjs zkey contribute build/entros_hamming_0000.zkey build/entros_hamming_final.zkey \
    --name="local-test" -e="local-test-$(openssl rand -hex 8)"
  npx snarkjs zkey verify build/entros_hamming.r1cs build/pot12_final.ptau build/entros_hamming_final.zkey
  echo "=== Test build complete (keys/ unchanged) ==="
  echo "  Proving key: build/entros_hamming_final.zkey"
  echo "  WASM:        build/entros_hamming_js/entros_hamming.wasm"
  echo "  For PRODUCTION keys, run a real ceremony: scripts/setup.sh --ceremony (see CEREMONY.md)"
  exit 0
fi

# ---- MODE = ceremony -------------------------------------------------------
CONTRIBUTORS="${CEREMONY_CONTRIBUTORS:-1}"
BEACON="${CEREMONY_BEACON:-}"            # optional 32-byte hex for beacon finalization
TRANSCRIPT="build/ceremony_transcript.txt"

echo "Phase-2 ceremony: $CONTRIBUTORS contributor(s)"
{
  echo "IAM Hamming circuit — Phase 2 ceremony transcript"
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
  # A real ceremony has each contributor supply their OWN entropy on their OWN
  # machine (interactive -e prompt), then hand $NEXT to the next operator. The
  # scripted entropy here is the dev/CI shape; CEREMONY.md is the attested flow.
  echo "[contribution $i] contributor-$i" >> "$TRANSCRIPT"
  npx snarkjs zkey contribute "$PREV" "$NEXT" \
    --name="contributor-$i" -e="ceremony-$i-$(openssl rand -hex 16)" | tee -a "$TRANSCRIPT"
  PREV="$NEXT"
done

FINAL="build/entros_hamming_final.zkey"
if [ -n "$BEACON" ]; then
  echo "Applying public beacon finalization..."
  npx snarkjs zkey beacon "$PREV" "$FINAL" "$BEACON" 10 -n="final beacon" | tee -a "$TRANSCRIPT"
else
  cp "$PREV" "$FINAL"
fi

echo "Verifying final zkey against the r1cs + ptau..."
npx snarkjs zkey verify build/entros_hamming.r1cs build/pot12_final.ptau "$FINAL" | tee -a "$TRANSCRIPT"

# Export verification key — the ONLY path that writes keys/.
echo "Exporting verification key to keys/ ..."
npx snarkjs zkey export verificationkey "$FINAL" keys/verification_key.json
node scripts/parse_vk_to_rust.js keys/verification_key.json keys/

echo "=== Ceremony complete ==="
echo "  Wrote:      keys/verification_key.json, keys/verifying_key.rs"
echo "  Transcript: $TRANSCRIPT"
echo "  NEXT: redeploy per CEREMONY.md — entros-verifier program upgrade (VK const),"
echo "        plus the mobile/mopro/web .zkey + wasm artifacts. Rotate out the old keys."
