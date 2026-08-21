# circuits

ZK circuit definitions for the Entros Protocol. The circuit proves two Poseidon openings and a bounded Hamming distance without revealing either fingerprint.

## Release compatibility

The current source tree and `keys/` contain an unpublished circuit successor with explicit public-input range constraints.

The deployed devnet verifier, web artifacts, mobile artifacts, and mopro package share the previous proving-key generation. Do not mix either generation.

The next circuit release must regenerate and verify every proving and verifying artifact in one coordinated migration. The multi-party ceremony follows that circuit freeze.

## Circuit

**`entros_hamming.circom`** is the main Groth16 circuit on BN254. It has 2,030 constraints.

Proves three things:
1. `Poseidon(pack(ft_new), salt_new) == commitment_new`
2. `Poseidon(pack(ft_prev), salt_prev) == commitment_prev`
3. `min_distance <= HammingDistance(ft_new, ft_prev) < threshold`

Public inputs: `commitment_new`, `commitment_prev`, `threshold`, `min_distance`
Private witnesses: `ft_new[256]`, `ft_prev[256]`, `salt_new`, `salt_prev`

## Trusted Setup

Groth16 requires a structured reference string produced by a trusted setup ceremony. The current setup uses:

- **Phase 1 (Powers of Tau):** Hermez community ceremony (`powersOfTau28_hez_final_12.ptau`). This phase is reusable across circuits.
- **Phase 2 (Circuit-specific):** Single contributor with entropy from `openssl rand` + timestamp. This is the phase that requires multiple independent contributors for production security.

**Current status: development setup.** The Phase 2 ceremony has a single contributor. The toxic waste (secret randomness used to derive the proving/verification keys) is known to whoever ran `scripts/setup.sh`. If retained, it could be used to forge proofs that pass on-chain verification.

**What this means in practice:**
- The devnet setup supports protocol testing. It does not meet the mainnet ceremony requirement.
- Mainnet requires a multi-party computation ceremony with independent contributors. One honest contributor protects the setup. The Hermez/snarkjs protocol verifies each contribution.

**Mainnet ceremony:** [`CEREMONY.md`](./CEREMONY.md) defines the contributor protocol, transcript format, and deployment checklist. Run it
via `scripts/setup.sh --ceremony`. Only this mode writes `keys/`. The default
`scripts/setup.sh` is a local test build that never touches `keys/`.

## Setup

```bash
# Prerequisites: Node.js 24.15.0, npm 11.12.1, Circom 2.2.3

npm ci
npm run setup                 # Test build: compile + local proving key in build/ (keys/ untouched)
./scripts/setup.sh --ceremony # Single-machine ceremony mechanics: writes keys/ (see CEREMONY.md)
npm run typecheck
npm run verify-artifacts
npm test
```

`circuit-lock.json` pins the compiler, Powers of Tau digest, constraint count, compiled artifacts, and key serialization.

## Proof Generation

```bash
# Generate a proof with the local test key.
npm run prove -- <input.json> [proof.json] [public.json]

# Verify the proof with the matching local test key.
npm run verify -- [proof.json] [public.json]
```

## Verification Key

`keys/verification_key.json` is the snarkjs key for the unpublished successor.

`keys/verifying_key.rs` is its Rust representation for `groth16-solana`.

Do not copy this Rust key into `protocol-core` alone. Web, mobile, mopro, and the on-chain verifier must move together.

## License

MIT
