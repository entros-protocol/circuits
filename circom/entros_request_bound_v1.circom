pragma circom 2.1.0;

include "hamming_relation.circom";

template RequestBoundHamming(n_bits) {
    signal input ft_new[n_bits];
    signal input ft_prev[n_bits];
    signal input salt_new;
    signal input salt_prev;
    signal input commitment_new;
    signal input commitment_prev;
    signal input threshold;
    signal input min_distance;
    signal input request_digest_hi;
    signal input request_digest_lo;

    component hamming = IAMHamming(n_bits);
    hamming.ft_new <== ft_new;
    hamming.ft_prev <== ft_prev;
    hamming.salt_new <== salt_new;
    hamming.salt_prev <== salt_prev;
    hamming.commitment_new <== commitment_new;
    hamming.commitment_prev <== commitment_prev;
    hamming.threshold <== threshold;
    hamming.min_distance <== min_distance;

    component digest_hi_bits = Num2Bits(128);
    component digest_lo_bits = Num2Bits(128);
    digest_hi_bits.in <== request_digest_hi;
    digest_lo_bits.in <== request_digest_lo;

    // Nonlinear constraints retain both public digest limbs during optimization.
    signal digest_hi_square <== request_digest_hi * request_digest_hi;
    signal digest_lo_square <== request_digest_lo * request_digest_lo;
}

component main {public [commitment_new, commitment_prev, threshold, min_distance, request_digest_hi, request_digest_lo]} = RequestBoundHamming(256);
