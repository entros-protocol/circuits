pragma circom 2.1.0;

include "hamming_relation.circom";

component main {public [commitment_new, commitment_prev, threshold, min_distance]} = IAMHamming(256);
