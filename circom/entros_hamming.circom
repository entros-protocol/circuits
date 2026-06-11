pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "hamming_distance.circom";
include "commitment_check.circom";

// IAM Protocol Hamming Distance Proof Circuit
//
// Proves four things without revealing the fingerprints:
// 1. ft_new hashes to commitment_new under salt_new
// 2. ft_prev hashes to commitment_prev under salt_prev
// 3. HammingDistance(ft_new, ft_prev) < threshold
// 4. HammingDistance(ft_new, ft_prev) >= min_distance (prevents perfect replay)
//
// Public inputs: commitment_new, commitment_prev, threshold, min_distance
// Private witnesses: ft_new[256], ft_prev[256], salt_new, salt_prev

template IAMHamming(n_bits) {
    // Private witnesses
    signal input ft_new[n_bits];
    signal input ft_prev[n_bits];
    signal input salt_new;
    signal input salt_prev;

    // Public inputs
    signal input commitment_new;
    signal input commitment_prev;
    signal input threshold;
    signal input min_distance;

    // H1: range-bound the public comparator inputs. circomlib's LessThan(9) /
    // GreaterEqThan(9) below do NOT constrain their own operands, so a prover
    // could set threshold or min_distance to a field value ≈ p that wraps past
    // the 9-bit comparison and defeats the drift bound — undetected by any
    // verifier that doesn't separately range-check (mobile / mopro / raw
    // snarkjs; the on-chain verifier already does). Num2Bits(9) forces both
    // into 0..511 — the comparators' valid domain, covering the 0..256 Hamming
    // range with margin — so an out-of-range value fails witness generation.
    component threshold_bits = Num2Bits(9);
    threshold_bits.in <== threshold;
    component min_distance_bits = Num2Bits(9);
    min_distance_bits.in <== min_distance;

    // 1. Enforce all fingerprint bits are binary
    for (var i = 0; i < n_bits; i++) {
        ft_new[i] * (1 - ft_new[i]) === 0;
        ft_prev[i] * (1 - ft_prev[i]) === 0;
    }

    // 2. Verify commitment for new fingerprint
    component check_new = CommitmentCheck(n_bits);
    check_new.bits <== ft_new;
    check_new.salt <== salt_new;
    check_new.commitment <== commitment_new;

    // 3. Verify commitment for previous fingerprint
    component check_prev = CommitmentCheck(n_bits);
    check_prev.bits <== ft_prev;
    check_prev.salt <== salt_prev;
    check_prev.commitment <== commitment_prev;

    // 4. Compute Hamming distance
    component hd = HammingDistance(n_bits);
    hd.a <== ft_new;
    hd.b <== ft_prev;

    // 5. Assert distance < threshold (maximum allowed drift)
    // LessThan(9) supports values 0..511, enough for max distance 256
    component lt = LessThan(9);
    lt.in[0] <== hd.distance;
    lt.in[1] <== threshold;
    lt.out === 1;

    // 6. Assert distance >= min_distance (prevents perfect replay / synthetic consistency)
    // GreaterEqThan(9) checks that distance is at least min_distance
    component gte = GreaterEqThan(9);
    gte.in[0] <== hd.distance;
    gte.in[1] <== min_distance;
    gte.out === 1;
}

component main {public [commitment_new, commitment_prev, threshold, min_distance]} = IAMHamming(256);
