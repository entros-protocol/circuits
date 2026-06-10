# circuits

ZK circuit definitions for the Entros Protocol. Proves that the Hamming distance between two Poseidon-committed Temporal Fingerprints is below a threshold, without revealing either fingerprint.

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

`keys/verification_key.json` — snarkjs format, committed to the repo.
`keys/verifying_key.rs` — Rust format for `groth16-solana`, used by `protocol-core/entros-verifier`.

## License

MIT
