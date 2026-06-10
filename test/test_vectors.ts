import * as snarkjs from "snarkjs";
import { createHash } from "crypto";

const WASM_PATH = "build/entros_hamming_js/entros_hamming.wasm";
const ZKEY_PATH = "build/entros_hamming_final.zkey";
const VK_PATH = "keys/verification_key.json";

// Deterministic PRNG for reproducible test vectors.
// Mulberry32 seeded from a hash of a label string.
function seededRng(label: string): () => number {
  const hash = createHash("sha256").update(label).digest();
  let state = hash.readUInt32BE(0);
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// BN254 scalar field prime
export const F_p = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617"
);

// Poseidon hash using circomlibjs (matches circomlib's Poseidon(3) in-circuit)
let poseidonFn: any = null;

async function getPoseidon() {
  if (!poseidonFn) {
    const circomlibjs = await import("circomlibjs");
    const poseidon = await circomlibjs.buildPoseidon();
    poseidonFn = poseidon;
  }
  return poseidonFn;
}

// Pack 256 bits into two 128-bit field elements (matching circuit's Bits2Num)
function packBitsToFieldElements(bits: number[]): [bigint, bigint] {
  let lo = BigInt(0);
  for (let i = 0; i < 128; i++) {
    if (bits[i] === 1) {
      lo += BigInt(1) << BigInt(i);
    }
  }
  let hi = BigInt(0);
  for (let i = 0; i < 128; i++) {
    if (bits[128 + i] === 1) {
      hi += BigInt(1) << BigInt(i);
    }
  }
  return [lo, hi];
}

// Compute Poseidon commitment: Poseidon(pack_lo, pack_hi, salt)
async function computeCommitment(
  bits: number[],
  salt: bigint
): Promise<bigint> {
  const poseidon = await getPoseidon();
  const [lo, hi] = packBitsToFieldElements(bits);
  const hash = poseidon([lo, hi, salt]);
  return poseidon.F.toObject(hash);
}

// Deterministic 256-bit fingerprint from a seed label
function randomFingerprint(seed = "default"): number[] {
  const rng = seededRng(`fingerprint-${seed}`);
  const bits: number[] = [];
  for (let i = 0; i < 256; i++) {
    bits.push(rng() > 0.5 ? 1 : 0);
  }
  return bits;
}

// Flip exactly `count` bits in a fingerprint copy (deterministic from seed)
function flipBits(bits: number[], count: number, seed = "flip"): number[] {
  if (count > bits.length) throw new Error(`Cannot flip ${count} bits in ${bits.length}-bit fingerprint`);
  const rng = seededRng(`flip-${seed}-${count}`);
  const result = [...bits];
  const indices = new Set<number>();
  while (indices.size < count) {
    indices.add(Math.floor(rng() * 256));
  }
  for (const i of indices) {
    result[i] = result[i] === 0 ? 1 : 0;
  }
  return result;
}

// Deterministic salt (field element) from seed label
function randomSalt(seed = "salt"): bigint {
  const hash = createHash("sha256").update(`salt-${seed}`).digest();
  let val = BigInt(0);
  for (let i = 0; i < 31; i++) {
    val = (val << BigInt(8)) + BigInt(hash[i]!);
  }
  return val % F_p;
}

export interface TestInput {
  ft_new: number[];
  ft_prev: number[];
  salt_new: string;
  salt_prev: string;
  commitment_new: string;
  commitment_prev: string;
  threshold: string;
  min_distance: string;
}

// Generate a valid test case (min_distance <= Hamming distance < threshold)
export async function generateValidInput(
  flippedBits: number = 10,
  threshold: number = 30,
  minDistance: number = 3,
  seed: string = "default"
): Promise<TestInput> {
  const ft_prev = randomFingerprint(`${seed}-prev`);
  const ft_new = flipBits(ft_prev, flippedBits, seed);
  const salt_new = randomSalt(`${seed}-new`);
  const salt_prev = randomSalt(`${seed}-prev`);

  const commitment_new = await computeCommitment(ft_new, salt_new);
  const commitment_prev = await computeCommitment(ft_prev, salt_prev);

  return {
    ft_new,
    ft_prev,
    salt_new: salt_new.toString(),
    salt_prev: salt_prev.toString(),
    commitment_new: commitment_new.toString(),
    commitment_prev: commitment_prev.toString(),
    threshold: threshold.toString(),
    min_distance: minDistance.toString(),
  };
}

// Generate an invalid test case (Hamming distance >= threshold)
export async function generateInvalidInput(
  flippedBits: number = 200,
  threshold: number = 30,
  minDistance: number = 3,
  seed: string = "invalid"
): Promise<TestInput> {
  return generateValidInput(flippedBits, threshold, minDistance, seed);
}

// Generate proof from input
export async function generateProof(input: TestInput) {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    WASM_PATH,
    ZKEY_PATH
  );
  return { proof, publicSignals };
}

// Serialize proof for on-chain submission (groth16-solana format)
export function serializeProofForSolana(proof: any): {
  proofA: Uint8Array;
  proofB: Uint8Array;
  proofC: Uint8Array;
} {
  // Convert decimal strings to 32-byte big-endian arrays
  function toBigEndian32(decStr: string): Uint8Array {
    let n = BigInt(decStr);
    const bytes = new Uint8Array(32);
    for (let i = 31; i >= 0; i--) {
      bytes[i] = Number(n & BigInt(0xff));
      n >>= BigInt(8);
    }
    return bytes;
  }

  // BN254 base field prime (for G1 point negation)
  const BN254_P = BigInt(
    "21888242871839275222246405745257275088696311157297823662689037894645226208583"
  );

  // proof_a: 2 coordinates, each 32 bytes = 64 bytes
  // CRITICAL: groth16-solana expects proof_a with negated y-coordinate
  const a0 = toBigEndian32(proof.pi_a[0]);
  const a1_negated = (BN254_P - BigInt(proof.pi_a[1])) % BN254_P;
  const a1 = toBigEndian32(a1_negated.toString());
  const proofA = new Uint8Array(64);
  proofA.set(a0, 0);
  proofA.set(a1, 32);

  // proof_b: 2x2 coordinates = 128 bytes (note: reversed c1,c0 ordering for G2)
  const b00 = toBigEndian32(proof.pi_b[0][1]); // c1 first
  const b01 = toBigEndian32(proof.pi_b[0][0]); // c0 second
  const b10 = toBigEndian32(proof.pi_b[1][1]);
  const b11 = toBigEndian32(proof.pi_b[1][0]);
  const proofB = new Uint8Array(128);
  proofB.set(b00, 0);
  proofB.set(b01, 32);
  proofB.set(b10, 64);
  proofB.set(b11, 96);

  // proof_c: 2 coordinates = 64 bytes
  const c0 = toBigEndian32(proof.pi_c[0]);
  const c1 = toBigEndian32(proof.pi_c[1]);
  const proofC = new Uint8Array(64);
  proofC.set(c0, 0);
  proofC.set(c1, 32);

  return { proofA, proofB, proofC };
}

export { WASM_PATH, ZKEY_PATH, VK_PATH };
