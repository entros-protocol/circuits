import { expect } from "chai";
import * as snarkjs from "snarkjs";
import {
  generateValidInput,
  generateInvalidInput,
  generateProof,
  serializeProofForSolana,
  F_p,
  ZKEY_PATH,
} from "./test_vectors";

describe("Entros Hamming Distance Circuit", function () {
  this.timeout(120000); // ZK proof generation can take time

  let vk: unknown;

  before(async () => {
    // Derive the verification key from the SAME proving key the proofs use, so
    // the suite tests circuit logic (prove + verify with a matched pair) rather
    // than whether the committed keys/ happen to match the current circuit —
    // which they intentionally won't between a circuit change (e.g. H1) and the
    // key-regeneration rollout.
    vk = await snarkjs.zKey.exportVerificationKey(ZKEY_PATH);
  });

  it("accepts valid proof (distance within range)", async () => {
    const input = await generateValidInput(10, 30, 3);
    const { proof, publicSignals } = await generateProof(input);
    const valid = await snarkjs.groth16.verify(vk, publicSignals, proof);
    expect(valid).to.be.true;
  });

  it("rejects proof with distance above threshold", async () => {
    const input = await generateInvalidInput(200, 30, 3);
    try {
      await generateProof(input);
      expect.fail("Proof generation should have failed");
    } catch (err: any) {
      expect(err).to.exist;
    }
  });

  it("rejects proof with distance below minimum (perfect replay)", async () => {
    // Distance 1 is below min_distance 3 — should fail
    const input = await generateValidInput(1, 30, 3);
    try {
      await generateProof(input);
      expect.fail("Proof generation should have failed — distance below minimum");
    } catch (err: any) {
      expect(err).to.exist;
    }
  });

  it("rejects proof with zero distance (exact replay)", async () => {
    // Distance 0 — identical fingerprints — should fail
    const input = await generateValidInput(0, 30, 3);
    try {
      await generateProof(input);
      expect.fail("Proof generation should have failed — zero distance");
    } catch (err: any) {
      expect(err).to.exist;
    }
  });

  it("accepts proof at exact min_distance boundary", async () => {
    // Distance exactly equals min_distance (>= should pass)
    const input = await generateValidInput(3, 30, 3);
    const { proof, publicSignals } = await generateProof(input);
    const valid = await snarkjs.groth16.verify(vk, publicSignals, proof);
    expect(valid).to.be.true;
  });

  it("rejects proof with wrong commitment", async () => {
    const input = await generateValidInput(10, 30, 3);
    input.commitment_new = "12345";
    try {
      await generateProof(input);
      expect.fail("Proof generation should have failed");
    } catch (err: any) {
      expect(err).to.exist;
    }
  });

  it("rejects proof with wrong salt", async () => {
    const input = await generateValidInput(10, 30, 3);
    input.salt_new = "99999";
    try {
      await generateProof(input);
      expect.fail("Proof generation should have failed");
    } catch (err: any) {
      expect(err).to.exist;
    }
  });

  it("rejects proof at exact threshold boundary", async () => {
    const input = await generateValidInput(30, 30, 3);
    try {
      await generateProof(input);
      expect.fail("Proof generation should have failed");
    } catch (err: any) {
      expect(err).to.exist;
    }
  });

  it("accepts proof one below threshold", async () => {
    const input = await generateValidInput(29, 30, 3);
    const { proof, publicSignals } = await generateProof(input);
    const valid = await snarkjs.groth16.verify(vk, publicSignals, proof);
    expect(valid).to.be.true;
  });

  it("accepts distance=1 with min_distance=0", async () => {
    const input = await generateValidInput(1, 30, 0, "min0");
    const { proof, publicSignals } = await generateProof(input);
    const valid = await snarkjs.groth16.verify(vk, publicSignals, proof);
    expect(valid).to.be.true;
  });

  it("rejects distance=5 when min_distance > threshold (impossible range)", async () => {
    // min_distance=10, threshold=5: no valid distance exists (need >= 10 AND < 5)
    const input = await generateValidInput(5, 5, 10, "impossible");
    try {
      await generateProof(input);
      expect.fail("Should have thrown — impossible constraint range");
    } catch (err: any) {
      expect(err.message).to.include("Assert Failed");
    }
  });

  it("accepts minimum viable distance with tight threshold", async () => {
    // distance=3, threshold=4, min_distance=3: exactly at lower bound, under upper
    const input = await generateValidInput(3, 4, 3, "tight");
    const { proof, publicSignals } = await generateProof(input);
    const valid = await snarkjs.groth16.verify(vk, publicSignals, proof);
    expect(valid).to.be.true;
  });

  // H1: the public comparator inputs are now range-bound by Num2Bits(9).
  // Pre-fix, threshold or min_distance set to a field value ≈ p aliased past
  // the 9-bit LessThan/GreaterEqThan and defeated the drift bound for any
  // verifier that didn't separately range-check. These now fail witness
  // generation at the Num2Bits constraint.
  it("rejects threshold set to a wrapping field value (H1)", async () => {
    const input = await generateValidInput(10, 30, 3, "h1-threshold");
    input.threshold = (F_p - 1n).toString();
    try {
      await generateProof(input);
      expect.fail("Proof generation should have failed — threshold exceeds the 9-bit bound");
    } catch (err: any) {
      expect(err).to.exist;
    }
  });

  it("rejects min_distance set to a wrapping field value (H1)", async () => {
    const input = await generateValidInput(10, 30, 3, "h1-mindist");
    input.min_distance = (F_p - 1n).toString();
    try {
      await generateProof(input);
      expect.fail("Proof generation should have failed — min_distance exceeds the 9-bit bound");
    } catch (err: any) {
      expect(err).to.exist;
    }
  });

  it("rejects threshold just above the 9-bit bound — 512 (H1)", async () => {
    // 512 is the first value that doesn't fit in 9 bits (0..511). Confirms the
    // bound is exactly 9-bit, not merely "rejects huge field values".
    const input = await generateValidInput(10, 30, 3, "h1-512");
    input.threshold = "512";
    try {
      await generateProof(input);
      expect.fail("Proof generation should have failed — 512 exceeds the 9-bit bound");
    } catch (err: any) {
      expect(err).to.exist;
    }
  });

  it("serializes proof in groth16-solana format", async () => {
    const input = await generateValidInput(10, 30, 3);
    const { proof, publicSignals } = await generateProof(input);
    const { proofA, proofB, proofC } = serializeProofForSolana(proof);

    expect(proofA.length).to.equal(64);
    expect(proofB.length).to.equal(128);
    expect(proofC.length).to.equal(64);

    // 4 public inputs, each 32 bytes
    expect(publicSignals.length).to.equal(4);
  });
});
