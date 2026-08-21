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
    // Derive the verification key from the local proving key so the suite uses a matched pair.
    // The artifact parity gate checks the committed verification key separately.
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
    } catch {
      return;
    }
    expect.fail("Proof generation should have failed");
  });

  it("rejects proof with distance below minimum (perfect replay)", async () => {
    const input = await generateValidInput(1, 30, 3);
    try {
      await generateProof(input);
    } catch {
      return;
    }
    expect.fail("Proof generation should have failed because distance is below the minimum");
  });

  it("rejects proof with zero distance (exact replay)", async () => {
    const input = await generateValidInput(0, 30, 3);
    try {
      await generateProof(input);
    } catch {
      return;
    }
    expect.fail("Proof generation should have failed because distance is zero");
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
    } catch {
      return;
    }
    expect.fail("Proof generation should have failed");
  });

  it("rejects proof with wrong salt", async () => {
    const input = await generateValidInput(10, 30, 3);
    input.salt_new = "99999";
    try {
      await generateProof(input);
    } catch {
      return;
    }
    expect.fail("Proof generation should have failed");
  });

  it("rejects proof at exact threshold boundary", async () => {
    const input = await generateValidInput(30, 30, 3);
    try {
      await generateProof(input);
    } catch {
      return;
    }
    expect.fail("Proof generation should have failed");
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
    } catch (error: unknown) {
      if (!(error instanceof Error)) {
        throw error;
      }
      expect(error.message).to.include("Assert Failed");
      return;
    }
    expect.fail("Proof generation should have failed for an impossible constraint range");
  });

  it("accepts minimum viable distance with tight threshold", async () => {
    // distance=3, threshold=4, min_distance=3: exactly at lower bound, under upper
    const input = await generateValidInput(3, 4, 3, "tight");
    const { proof, publicSignals } = await generateProof(input);
    const valid = await snarkjs.groth16.verify(vk, publicSignals, proof);
    expect(valid).to.be.true;
  });

  // Num2Bits constrains both public comparator inputs to the nine-bit domain.
  it("rejects threshold set to a wrapping field value", async () => {
    const input = await generateValidInput(10, 30, 3, "h1-threshold");
    input.threshold = (F_p - 1n).toString();
    try {
      await generateProof(input);
    } catch {
      return;
    }
    expect.fail("Proof generation should have failed because threshold exceeds the nine-bit bound");
  });

  it("rejects min_distance set to a wrapping field value", async () => {
    const input = await generateValidInput(10, 30, 3, "h1-mindist");
    input.min_distance = (F_p - 1n).toString();
    try {
      await generateProof(input);
    } catch {
      return;
    }
    expect.fail("Proof generation should have failed because min_distance exceeds the nine-bit bound");
  });

  it("rejects threshold 512 above the nine-bit bound", async () => {
    const input = await generateValidInput(10, 30, 3, "h1-512");
    input.threshold = "512";
    try {
      await generateProof(input);
    } catch {
      return;
    }
    expect.fail("Proof generation should have failed because 512 exceeds the nine-bit bound");
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
