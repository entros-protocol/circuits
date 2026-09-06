# Phase-2 Trusted-Setup Ceremony Runbook

## Request-bound circuit candidate

The next circuit is `circom/entros_request_bound_v1.circom`.
`request-bound-circuit.json` records its source hashes, compiler, optimization, and deterministic artifacts.
The candidate uses Circom 2.2.3 with O1 and has 2,290 constraints.

R1CS SHA-256:

```text
36065322931fdcf3fb9ed4ff0e0977bf93795fb51634b805a4ad95a23e494b1a
```

WASM SHA-256:

```text
ac3dc8953f55b2580f291683ac8d36a6d1e5606c83687be454edff2380e892fb
```

The six public inputs, in order, are:

1. `commitment_new`
2. `commitment_prev`
3. `threshold`
4. `min_distance`
5. `request_digest_hi`
6. `request_digest_lo`

The exported verification key must have seven IC entries.
The last two entries must be nondegenerate and match the accepted request-binding tests.
Compile with explicit O1. O2 produces a different R1CS and requires different keys.

The candidate still requires devnet mint and update acceptance before ceremony approval.
The existing isolated test contribution cannot serve as the release contribution.
Generate any approved devnet test contribution in a new directory and identify it as unsuitable for mainnet.
Preserve existing keys and packaged artifacts until the owner approves their replacement.

Both active programs require the `request-bound-v1` feature and the same explicit deployment domain.
The verifier also requires the matching six-input verification key.
Review browser manifests, native build inputs, and program binaries as one artifact generation.
The default setup and upgrade scripts still select the legacy generation.

Do not execute the legacy procedure below for this candidate.
Prepare a separate ceremony transcript and fresh output paths after candidate acceptance and owner approval.

## Legacy four-input procedure

The remaining sections document the previous `entros_hamming.circom` generation.
Its four-input checks do not apply to the request-bound candidate.

The Groth16 proving system for `entros_hamming.circom` needs a per-circuit Phase-2
trusted setup. Until a multi-party ceremony runs, the setup has a **single contributor**
(see `README.md`). Whoever generated it knows the toxic waste and could forge proofs
that pass on-chain verification. This document is the operator runbook for replacing it
with a real ceremony where the setup is only compromised if **every** contributor colludes.

> Two ceremony phases, don't confuse them:
> - **Phase 1 (Powers of Tau)** is circuit-agnostic and already done. We use the public
>   Hermez `powersOfTau28_hez_final_12.ptau`. Not our concern.
> - **Phase 2 (this document)** is circuit-specific and must be re-run whenever the circuit
>   changes. Run it on the final circuit after adding public-input range constraints.

## When to run

- Before mainnet.
- After any change to `circom/entros_hamming.circom` or its includes, because a circuit
  change produces a new R1CS → new proving/verifying keys. The committed `keys/` and the
  deployed verifier remain the matched *previous* pair until this ceremony + the redeploy
  below land together.

## Roles

- **Coordinator:** compiles the final circuit, runs the initial setup, sequences the
  hand-off, finalizes, exports the VK, and publishes the transcript.
- **Contributors:** at least three independent operators from different organizations (for example, an
  Anza engineer, a Light Protocol engineer, an academic). More is better; the security
  assumption is "at least one contributor destroyed their toxic waste."

## Ceremony sequence

The coordinator starts from the committed circuit. `scripts/setup.sh --ceremony` automates
the **single-machine** variant for devnet drills. For **mainnet**,
each contributor runs their step on their **own air-gapped machine** and hands the `.zkey`
to the next, so no single machine ever sees two contributors' entropy.

1. **Coordinator: initialize** on the final, committed circuit:
   ```
   circom circom/entros_hamming.circom --r1cs --wasm --sym --output build/ -l node_modules/circomlib/circuits
   snarkjs groth16 setup build/entros_hamming.r1cs build/pot12_final.ptau build/entros_hamming_0000.zkey
   ```
   Publish the circuit hash (printed by the next `zkey contribute`) so contributors can
   confirm they're all contributing to the same circuit.

2. **Each contributor i (1..N), on their own machine:**
   - Receive `entros_hamming_<i-1>.zkey` from the coordinator/previous contributor.
   - Contribute their **own** entropy. Use the interactive prompt. Do not pass `-e` from a script:
     ```
     snarkjs zkey contribute entros_hamming_<i-1>.zkey entros_hamming_<i>.zkey --name="<org / handle>"
     # snarkjs prompts for random text. Use a hardware random-number generator when available.
     ```
   - Record the printed **Contribution Hash** and **sign it** (PGP or a Solana key).
   - **Destroy the toxic waste**: remove the machine's RAM state and `entros_hamming_<i-1>.zkey`.
     Attest destruction in writing alongside the signed hash.
   - Hand `entros_hamming_<i>.zkey` to the next contributor (never the earlier files).

3. **Coordinator: finalize, verify, export:**
   ```
   # Optional public-beacon finalization (e.g. a future Bitcoin block hash):
   snarkjs zkey beacon entros_hamming_<N>.zkey entros_hamming_final.zkey <beaconHashHex> 10 -n="final beacon"
   # else: cp entros_hamming_<N>.zkey entros_hamming_final.zkey
   snarkjs zkey verify build/entros_hamming.r1cs build/pot12_final.ptau build/entros_hamming_final.zkey
   snarkjs zkey export verificationkey build/entros_hamming_final.zkey keys/verification_key.json
   node scripts/parse_vk_to_rust.js keys/verification_key.json keys/
   ```
   The single-machine equivalent of steps 1–3 is `CEREMONY_CONTRIBUTORS=<N> CEREMONY_BEACON=<hex> scripts/setup.sh --ceremony`.

## Transcript & attestation

Publish, for every contribution: index, contributor name/org, the **contribution hash**,
the contributor's **signature** over that hash, and their **toxic-waste-destruction
attestation**. Publish the **circuit hash**, the optional **beacon** value, and the final
`keys/verification_key.json`. Anyone can then re-verify the chain with `snarkjs zkey verify`
and confirm each hash matches a signed attestation. `scripts/setup.sh --ceremony` writes a
starter transcript to `build/ceremony_transcript.txt` (circuit hash + per-contribution hashes).

## Redeploy checklist (after the ceremony)

Every artifact below currently carries the previous (single-contributor) key and **all** must
be regenerated from the ceremony output and redeployed together. A partial swap breaks
proofs (the on-chain VK and the prover keys must match):

| Artifact | Path | Action |
|---|---|---|
| VK (JSON + Rust) | `circuits/keys/verification_key.json`, `keys/verifying_key.rs` | commit the ceremony output |
| On-chain VK constant | `protocol-core/programs/entros-verifier/src/verifying_key.rs` | **entros-verifier program upgrade**. Use the protocol multisig as the program upgrade authority for mainnet. |
| Mobile / mopro prover | `entros-mobile/assets/circuits/entros_hamming_final.zkey` and `entros-mopro/test-vectors/circom/entros_hamming_final.zkey` + `entroshamming.wasm` (note: w2c2 strips the underscore from the wasm name) | rebuild and release the mobile application |
| Web prover | `entros.io/public/circuits/entros_hamming.wasm` + `entros_hamming_final.zkey` (served via `NEXT_PUBLIC_{WASM,ZKEY}_URL`) | re-host (Vercel) |

Then **rotate out** the old forge-capable `.zkey`/VK everywhere and publish the transcript.

## Verification

- `snarkjs zkey verify build/entros_hamming.r1cs build/pot12_final.ptau keys/...` passes, and
  each transcript contribution hash matches its signed attestation.
- The on-chain `verifying_key.rs` byte-matches `parse_vk_to_rust.js` output from the ceremony
  VK, and still reports **4 public inputs / 5 IC entries**. The range constraints do not change the public-signal layout.
- A web and a mobile prover each generate a proof that verifies against the redeployed
  `entros-verifier`.
