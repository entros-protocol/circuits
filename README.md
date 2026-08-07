# circuits

ZK circuit definitions for the Entros Protocol. The circuit proves two Poseidon openings and a bounded Hamming distance without revealing either fingerprint.

## Release compatibility

The current source tree and `keys/` contain an unpublished circuit successor with explicit public-input range constraints.

The deployed devnet verifier, web artifacts, mobile artifacts, and mopro package share the previous proving-key generation. Do not mix either generation.

The next circuit release must regenerate and verify every proving and verifying artifact in one coordinated migration. The multi-party ceremony follows that circuit freeze.

## Circuit

**`entros_hamming.circom`** — Main Groth16 circuit (BN254). ~2,010 constraints.

Proves three things:
1. `Poseidon(pack(ft_new), salt_new) == commitment_new`
2. `Poseidon(pack(ft_prev), salt_prev) == commitment_prev`
3. `min_distance <= HammingDistance(ft_new, ft_prev) < threshold`

Public inputs: `commitment_new`, `commitment_prev`, `threshold`, `min_distance`
Private witnesses: `ft_new[256]`, `ft_prev[256]`, `salt_new`, `salt_prev`

## Trusted Setup

Groth16 requires a structured reference string (SRS) produced by a trusted setup ceremony. The current setup uses:

- **Phase 1 (Powers of Tau):** Hermez community ceremony (`powersOfTau28_hez_final_12.ptau`) — multi-contributor, production-grade. This phase is circuit-agnostic and reusable.
- **Phase 2 (Circuit-specific):** Single contributor with entropy from `openssl rand` + timestamp. This is the phase that requires multiple independent contributors for production security.

**Current status: development setup.** The Phase 2 ceremony has a single contributor. The toxic waste (secret randomness used to derive the proving/verification keys) is known to whoever ran `scripts/setup.sh`. If retained, it could be used to forge proofs that pass on-chain verification.

**What this means in practice:**
- On devnet, this is standard and acceptable. All Groth16 projects use single-contributor setups during development.
- For mainnet, a multi-party computation (MPC) ceremony is required where multiple independent contributors each add entropy. The toxic waste is only compromised if ALL contributors collude. The ceremony will follow the Hermez/snarkjs Phase 2 protocol with public verification of each contribution.

**Mainnet ceremony:** the full operator runbook — contributor protocol, transcript/attestation
format, and the post-ceremony redeploy checklist — is in [`CEREMONY.md`](./CEREMONY.md). Run it
via `scripts/setup.sh --ceremony` (the only mode that writes `keys/`); the default
`scripts/setup.sh` is a local test build that never touches `keys/`.

## Setup

```bash
# Prerequisites: circom (cargo install --git https://github.com/iden3/circom.git), Node.js >= 20

npm install
./scripts/setup.sh            # Test build: compile + local proving key in build/ (keys/ untouched)
./scripts/setup.sh --ceremony # Multi-party Phase-2 ceremony: writes keys/ (see CEREMONY.md)
npm test                      # Run circuit tests
```

## Proof Generation

```bash
# Generate a test proof (requires setup.sh to have been run)
npx snarkjs groth16 fullprove <input.json> build/entros_hamming_js/entros_hamming.wasm build/entros_hamming_final.zkey proof.json public.json
```

## Verification Key

`keys/verification_key.json` is the snarkjs key for the unpublished successor.

`keys/verifying_key.rs` is its Rust representation for `groth16-solana`.

Do not copy this Rust key into `protocol-core` alone. Web, mobile, mopro, and the on-chain verifier must move together.

## License

MIT
