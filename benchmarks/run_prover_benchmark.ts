/**
 * Deterministic 30-repetition client prover benchmark (#286).
 *
 * Evaluates the current Groth16 (BN254 / snarkjs WASM + JS) prover across:
 *   1. `entros_hamming` (2,030 R1CS constraints, 4 public inputs, production zkey)
 *   2. `entros_request_bound_v1` (2,290 R1CS constraints, 6 public inputs, ephemeral benchmark zkey in tmpdir)
 *
 * All positive and negative equivalence checks run before timed repetitions.
 * No files in `build/` or `keys/` are modified.
 */

import { execFileSync } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { performance } from "perf_hooks";
import * as snarkjs from "snarkjs";
import {
  generateValidInput,
  serializeProofForSolana,
  TestInput,
  VK_PATH,
  WASM_PATH,
  ZKEY_PATH,
} from "../test/test_vectors";

const REPETITIONS = 30;
const DEFAULT_DISTANCE = 12;
const DEFAULT_THRESHOLD = 30;
const DEFAULT_MIN_DISTANCE = 3;

interface LatencySummary {
  count: number;
  minMs: number;
  p25Ms: number;
  medianMs: number;
  p75Ms: number;
  iqrMs: number;
  meanMs: number;
  p95Ms: number;
  maxMs: number;
}

interface EquivalenceCheckResult {
  name: string;
  expectedValid: boolean;
  observedValid: boolean;
  passed: boolean;
}

interface CircuitBenchmarkReport {
  circuitId: string;
  proverBackend: string;
  constraints: number;
  publicInputs: number;
  wasmBytes: number;
  zkeyBytes: number;
  vkJsonBytes: number;
  nativeArtifactBytes?: number;
  solanaProofBytes: number;
  equivalenceChecksPassed: boolean;
  equivalenceChecks: EquivalenceCheckResult[];
  coldFullProveMs: number;
  warmWitnessMs: LatencySummary | null;
  warmFullProveMs: LatencySummary;
  warmVerifyMs: LatencySummary;
  peakRssBytes: number;
  peakHeapUsedBytes: number;
}

interface ProverBenchmarkSuiteReport {
  schemaVersion: number;
  benchmarkId: string;
  repetitions: number;
  environment: {
    platform: string;
    arch: string;
    osRelease: string;
    cpuModel: string;
    cpuCores: number;
    totalMemoryBytes: number;
    nodeVersion: string;
  };
  circuits: CircuitBenchmarkReport[];
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1] ?? sorted[base];
  return sorted[base] + rest * (next - sorted[base]);
}

function summarizeLatencies(samples: number[]): LatencySummary {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const p25 = quantile(sorted, 0.25);
  const p50 = quantile(sorted, 0.5);
  const p75 = quantile(sorted, 0.75);
  const p95 = quantile(sorted, 0.95);
  return {
    count: sorted.length,
    minMs: round3(sorted[0] ?? 0),
    p25Ms: round3(p25),
    medianMs: round3(p50),
    p75Ms: round3(p75),
    iqrMs: round3(p75 - p25),
    meanMs: round3(sum / Math.max(1, sorted.length)),
    p95Ms: round3(p95),
    maxMs: round3(sorted[sorted.length - 1] ?? 0),
  };
}

function deriveDigestLimbs(seedLabel: string): {
  request_digest_hi: string;
  request_digest_lo: string;
} {
  const digest = createHash("sha256")
    .update(`entros-request-bound-v1:${seedLabel}`)
    .digest();
  const hi = BigInt(`0x${digest.subarray(0, 16).toString("hex")}`);
  const lo = BigInt(`0x${digest.subarray(16, 32).toString("hex")}`);
  return {
    request_digest_hi: hi.toString(),
    request_digest_lo: lo.toString(),
  };
}

async function runEquivalenceCheck(
  name: string,
  expectedValid: boolean,
  input: Record<string, string>,
  wasmPath: string,
  zkeyPath: string,
  vk: unknown,
): Promise<EquivalenceCheckResult> {
  let observedValid = false;
  try {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input,
      wasmPath,
      zkeyPath,
    );
    observedValid = await snarkjs.groth16.verify(vk, publicSignals, proof);
  } catch {
    observedValid = false;
  }
  return {
    name,
    expectedValid,
    observedValid,
    passed: observedValid === expectedValid,
  };
}

async function benchmarkCircuit(params: {
  circuitId: string;
  constraints: number;
  publicInputs: number;
  wasmPath: string;
  zkeyPath: string;
  vkPath: string;
  includeRequestDigestLimbs: boolean;
}): Promise<CircuitBenchmarkReport> {
  const vk = await snarkjs.zKey.exportVerificationKey(params.zkeyPath);
  const wasmBytes = fs.statSync(params.wasmPath).size;
  const zkeyBytes = fs.statSync(params.zkeyPath).size;
  const vkJsonBytes = Buffer.byteLength(JSON.stringify(vk, null, 2), "utf8");

  const attachLimbs = (
    base: TestInput,
    seedLabel: string,
    override?: { request_digest_hi?: string; request_digest_lo?: string },
  ): Record<string, string> => {
    if (!params.includeRequestDigestLimbs) {
      return { ...base };
    }
    const limbs = deriveDigestLimbs(seedLabel);
    return {
      ...base,
      request_digest_hi:
        override?.request_digest_hi ?? limbs.request_digest_hi,
      request_digest_lo:
        override?.request_digest_lo ?? limbs.request_digest_lo,
    };
  };

  // Cold start fullProve measurement (first invocation on this circuit)
  const coldInput = attachLimbs(
    await generateValidInput(
      DEFAULT_DISTANCE,
      DEFAULT_THRESHOLD,
      DEFAULT_MIN_DISTANCE,
      `${params.circuitId}:cold`,
    ),
    `${params.circuitId}:cold`,
  );
  const tCold0 = performance.now();
  const coldProofRes = await snarkjs.groth16.fullProve(
    coldInput,
    params.wasmPath,
    params.zkeyPath,
  );
  const coldFullProveMs = round3(performance.now() - tCold0);
  const coldVerified = await snarkjs.groth16.verify(
    vk,
    coldProofRes.publicSignals,
    coldProofRes.proof,
  );
  if (!coldVerified) {
    throw new Error(`Cold proof verification failed for ${params.circuitId}`);
  }
  const serializedSolana = serializeProofForSolana(coldProofRes.proof);
  const solanaProofBytes =
    serializedSolana.proofA.byteLength +
    serializedSolana.proofB.byteLength +
    serializedSolana.proofC.byteLength;

  // Equivalence checks (positive + negative)
  const eqChecks: EquivalenceCheckResult[] = [];
  eqChecks.push(
    await runEquivalenceCheck(
      "valid_interior_d12",
      true,
      attachLimbs(
        await generateValidInput(12, 30, 3, `${params.circuitId}:eq-d12`),
        `${params.circuitId}:eq-d12`,
      ),
      params.wasmPath,
      params.zkeyPath,
      vk,
    ),
  );
  eqChecks.push(
    await runEquivalenceCheck(
      "valid_lower_boundary_d3",
      true,
      attachLimbs(
        await generateValidInput(3, 30, 3, `${params.circuitId}:eq-d3`),
        `${params.circuitId}:eq-d3`,
      ),
      params.wasmPath,
      params.zkeyPath,
      vk,
    ),
  );
  eqChecks.push(
    await runEquivalenceCheck(
      "valid_upper_boundary_d29",
      true,
      attachLimbs(
        await generateValidInput(29, 30, 3, `${params.circuitId}:eq-d29`),
        `${params.circuitId}:eq-d29`,
      ),
      params.wasmPath,
      params.zkeyPath,
      vk,
    ),
  );
  eqChecks.push(
    await runEquivalenceCheck(
      "reject_below_min_d2",
      false,
      attachLimbs(
        await generateValidInput(2, 30, 3, `${params.circuitId}:eq-d2`),
        `${params.circuitId}:eq-d2`,
      ),
      params.wasmPath,
      params.zkeyPath,
      vk,
    ),
  );
  eqChecks.push(
    await runEquivalenceCheck(
      "reject_exact_replay_d0",
      false,
      attachLimbs(
        await generateValidInput(0, 30, 3, `${params.circuitId}:eq-d0`),
        `${params.circuitId}:eq-d0`,
      ),
      params.wasmPath,
      params.zkeyPath,
      vk,
    ),
  );
  eqChecks.push(
    await runEquivalenceCheck(
      "reject_at_threshold_d30",
      false,
      attachLimbs(
        await generateValidInput(30, 30, 3, `${params.circuitId}:eq-d30`),
        `${params.circuitId}:eq-d30`,
      ),
      params.wasmPath,
      params.zkeyPath,
      vk,
    ),
  );
  const tamperedCommitmentBase = await generateValidInput(
    10,
    30,
    3,
    `${params.circuitId}:eq-tampered-commit`,
  );
  eqChecks.push(
    await runEquivalenceCheck(
      "reject_tampered_commitment",
      false,
      attachLimbs(
        { ...tamperedCommitmentBase, commitment_new: "12345" },
        `${params.circuitId}:eq-tampered-commit`,
      ),
      params.wasmPath,
      params.zkeyPath,
      vk,
    ),
  );
  if (params.includeRequestDigestLimbs) {
    eqChecks.push(
      await runEquivalenceCheck(
        "reject_digest_limb_overflow_2pow128",
        false,
        attachLimbs(
          await generateValidInput(
            12,
            30,
            3,
            `${params.circuitId}:eq-limb-overflow`,
          ),
          `${params.circuitId}:eq-limb-overflow`,
          { request_digest_hi: (1n << 128n).toString() },
        ),
        params.wasmPath,
        params.zkeyPath,
        vk,
      ),
    );
  }

  const equivalenceChecksPassed = eqChecks.every((c) => c.passed);
  if (!equivalenceChecksPassed) {
    const failed = eqChecks.filter((c) => !c.passed).map((c) => c.name);
    throw new Error(
      `Equivalence checks failed for ${params.circuitId}: ${failed.join(", ")}`,
    );
  }

  // Pre-generate 30 deterministic inputs outside timed loop
  const inputs: Array<Record<string, string>> = [];
  for (let i = 0; i < REPETITIONS; i++) {
    const seed = `${params.circuitId}:rep-${i.toString().padStart(2, "0")}`;
    const base = await generateValidInput(
      DEFAULT_DISTANCE,
      DEFAULT_THRESHOLD,
      DEFAULT_MIN_DISTANCE,
      seed,
    );
    inputs.push(attachLimbs(base, seed));
  }

  // Warm up worker pool after equivalence checks before timed 30-rep loops
  await snarkjs.groth16.fullProve(inputs[0], params.wasmPath, params.zkeyPath);

  const witnessMs: number[] = [];
  const fullProveMs: number[] = [];
  const verifyMs: number[] = [];
  let peakRssBytes = process.memoryUsage().rss;
  let peakHeapUsedBytes = process.memoryUsage().heapUsed;

  for (let i = 0; i < REPETITIONS; i++) {
    const input = inputs[i];
    const memWitness: snarkjs.WitnessFile = { type: "mem" };
    const tWtns0 = performance.now();
    await snarkjs.wtns.calculate(input, params.wasmPath, memWitness);
    witnessMs.push(performance.now() - tWtns0);
  }

  for (let i = 0; i < REPETITIONS; i++) {
    const input = inputs[i];
    const tProve0 = performance.now();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input,
      params.wasmPath,
      params.zkeyPath,
    );
    fullProveMs.push(performance.now() - tProve0);

    const tVer0 = performance.now();
    const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
    verifyMs.push(performance.now() - tVer0);
    if (!ok) {
      throw new Error(
        `Verification failed on repetition ${i} for ${params.circuitId}`,
      );
    }

    const mem = process.memoryUsage();
    if (mem.rss > peakRssBytes) peakRssBytes = mem.rss;
    if (mem.heapUsed > peakHeapUsedBytes) peakHeapUsedBytes = mem.heapUsed;
  }

  return {
    circuitId: params.circuitId,
    proverBackend: "snarkjs-groth16-wasm",
    constraints: params.constraints,
    publicInputs: params.publicInputs,
    wasmBytes,
    zkeyBytes,
    vkJsonBytes,
    solanaProofBytes,
    equivalenceChecksPassed,
    equivalenceChecks: eqChecks,
    coldFullProveMs,
    warmWitnessMs: summarizeLatencies(witnessMs),
    warmFullProveMs: summarizeLatencies(fullProveMs),
    warmVerifyMs: summarizeLatencies(verifyMs),
    peakRssBytes,
    peakHeapUsedBytes,
  };
}

async function benchmarkMoproArkworks(
  circuitsRoot: string,
  tmpDir: string,
): Promise<CircuitBenchmarkReport | null> {
  const moproRoot = path.resolve(circuitsRoot, "..", "entros-mopro");
  const moproCargoToml = path.join(moproRoot, "Cargo.toml");
  const moproZkeyPath = path.join(
    moproRoot,
    "test-vectors",
    "circom",
    "entros_hamming_final.zkey",
  );
  if (!fs.existsSync(moproCargoToml) || !fs.existsSync(moproZkeyPath)) {
    return null;
  }

  const coldInput = await generateValidInput(
    DEFAULT_DISTANCE,
    DEFAULT_THRESHOLD,
    DEFAULT_MIN_DISTANCE,
    "entros_hamming_v1:cold",
  );
  const eqCases: Array<{
    name: string;
    expectedValid: boolean;
    input: TestInput;
  }> = [
    {
      name: "valid_interior_d12",
      expectedValid: true,
      input: await generateValidInput(12, 30, 3, "entros_hamming_v1:eq-d12"),
    },
    {
      name: "valid_lower_boundary_d3",
      expectedValid: true,
      input: await generateValidInput(3, 30, 3, "entros_hamming_v1:eq-d3"),
    },
    {
      name: "valid_upper_boundary_d29",
      expectedValid: true,
      input: await generateValidInput(29, 30, 3, "entros_hamming_v1:eq-d29"),
    },
    {
      name: "reject_below_min_d2",
      expectedValid: false,
      input: await generateValidInput(2, 30, 3, "entros_hamming_v1:eq-d2"),
    },
    {
      name: "reject_exact_replay_d0",
      expectedValid: false,
      input: await generateValidInput(0, 30, 3, "entros_hamming_v1:eq-d0"),
    },
    {
      name: "reject_at_threshold_d30",
      expectedValid: false,
      input: await generateValidInput(30, 30, 3, "entros_hamming_v1:eq-d30"),
    },
    {
      name: "reject_tampered_commitment",
      expectedValid: false,
      input: {
        ...(await generateValidInput(
          10,
          30,
          3,
          "entros_hamming_v1:eq-tampered-commit",
        )),
        commitment_new: "12345",
      },
    },
  ];

  const repInputs: TestInput[] = [];
  for (let i = 0; i < REPETITIONS; i++) {
    const seed = `entros_hamming_v1:rep-${i.toString().padStart(2, "0")}`;
    repInputs.push(
      await generateValidInput(
        DEFAULT_DISTANCE,
        DEFAULT_THRESHOLD,
        DEFAULT_MIN_DISTANCE,
        seed,
      ),
    );
  }

  const toRustWitnessJson = (inp: TestInput): string =>
    JSON.stringify({
      ft_new: inp.ft_new.map(String),
      ft_prev: inp.ft_prev.map(String),
      salt_new: [inp.salt_new],
      salt_prev: [inp.salt_prev],
      commitment_new: [inp.commitment_new],
      commitment_prev: [inp.commitment_prev],
      threshold: [inp.threshold],
      min_distance: [inp.min_distance],
    });

  const payloadPath = path.join(tmpDir, "mopro_inputs.json");
  const outputPath = path.join(tmpDir, "mopro_output.json");
  fs.writeFileSync(
    payloadPath,
    JSON.stringify({
      zkeyPath: moproZkeyPath,
      coldInputJson: toRustWitnessJson(coldInput),
      eqCases: eqCases.map((c) => ({
        name: c.name,
        expectedValid: c.expectedValid,
        inputJson: toRustWitnessJson(c.input),
      })),
      repInputJsons: repInputs.map((inp) => toRustWitnessJson(inp)),
    }),
  );

  const tmpTestPath = path.join(moproRoot, "tests", "prover_bench_ephemeral.rs");
  const rustTestSource = `
use entros_mopro::{generate_circom_proof, verify_circom_proof, ProofLib};
use serde::{Deserialize, Serialize};
use std::fs;
use std::time::Instant;

#[derive(Deserialize)]
struct EqCaseIn {
    name: String,
    #[serde(rename = "expectedValid")]
    expected_valid: bool,
    #[serde(rename = "inputJson")]
    input_json: String,
}

#[derive(Deserialize)]
struct BenchPayload {
    #[serde(rename = "zkeyPath")]
    zkey_path: String,
    #[serde(rename = "coldInputJson")]
    cold_input_json: String,
    #[serde(rename = "eqCases")]
    eq_cases: Vec<EqCaseIn>,
    #[serde(rename = "repInputJsons")]
    rep_input_jsons: Vec<String>,
}

#[derive(Serialize)]
struct EqCaseOut {
    name: String,
    #[serde(rename = "expectedValid")]
    expected_valid: bool,
    #[serde(rename = "observedValid")]
    observed_valid: bool,
    passed: bool,
}

#[derive(Serialize)]
struct BenchOut {
    #[serde(rename = "coldFullProveMs")]
    cold_full_prove_ms: f64,
    #[serde(rename = "eqChecks")]
    eq_checks: Vec<EqCaseOut>,
    #[serde(rename = "proveMs")]
    prove_ms: Vec<f64>,
    #[serde(rename = "verifyMs")]
    verify_ms: Vec<f64>,
    #[serde(rename = "peakRssBytes")]
    peak_rss_bytes: u64,
}

fn current_max_rss_bytes() -> u64 {
    let pid = std::process::id().to_string();
    if let Ok(out) = std::process::Command::new("ps").args(["-o", "rss=", "-p", &pid]).output() {
        if let Ok(text) = String::from_utf8(out.stdout) {
            if let Ok(kb) = text.trim().parse::<u64>() {
                return kb * 1024;
            }
        }
    }
    0
}

#[test]
fn run_ephemeral_mopro_bench() {
    let payload_path = std::env::var("ENTROS_MOPRO_BENCH_PAYLOAD").expect("payload path");
    let out_path = std::env::var("ENTROS_MOPRO_BENCH_OUT").expect("out path");
    let payload: BenchPayload = serde_json::from_str(&fs::read_to_string(payload_path).unwrap()).unwrap();

    let t_cold = Instant::now();
    let cold_res = generate_circom_proof(payload.zkey_path.clone(), payload.cold_input_json.clone(), ProofLib::Arkworks)
        .expect("cold proof");
    let cold_full_prove_ms = t_cold.elapsed().as_secs_f64() * 1000.0;
    assert!(verify_circom_proof(payload.zkey_path.clone(), cold_res, ProofLib::Arkworks).unwrap());

    let mut eq_checks = Vec::new();
    for case in &payload.eq_cases {
        let observed_valid = match generate_circom_proof(payload.zkey_path.clone(), case.input_json.clone(), ProofLib::Arkworks) {
            Ok(proof_res) => verify_circom_proof(payload.zkey_path.clone(), proof_res, ProofLib::Arkworks).unwrap_or(false),
            Err(_) => false,
        };
        eq_checks.push(EqCaseOut {
            name: case.name.clone(),
            expected_valid: case.expected_valid,
            observed_valid,
            passed: observed_valid == case.expected_valid,
        });
    }

    let mut prove_ms = Vec::with_capacity(payload.rep_input_jsons.len());
    let mut verify_ms = Vec::with_capacity(payload.rep_input_jsons.len());
    for inp in &payload.rep_input_jsons {
        let t0 = Instant::now();
        let res = generate_circom_proof(payload.zkey_path.clone(), inp.clone(), ProofLib::Arkworks).expect("rep proof");
        prove_ms.push(t0.elapsed().as_secs_f64() * 1000.0);

        let tv = Instant::now();
        let ok = verify_circom_proof(payload.zkey_path.clone(), res, ProofLib::Arkworks).expect("rep verify");
        verify_ms.push(tv.elapsed().as_secs_f64() * 1000.0);
        assert!(ok);
    }

    let out = BenchOut {
        cold_full_prove_ms,
        eq_checks,
        prove_ms,
        verify_ms,
        peak_rss_bytes: current_max_rss_bytes(),
    };
    fs::write(out_path, serde_json::to_string(&out).unwrap()).unwrap();
}
`;

  try {
    fs.writeFileSync(tmpTestPath, rustTestSource);
    execFileSync(
      "cargo",
      [
        "test",
        "--release",
        "--test",
        "prover_bench_ephemeral",
        "--",
        "--nocapture",
      ],
      {
        cwd: moproRoot,
        env: {
          ...process.env,
          ENTROS_MOPRO_BENCH_PAYLOAD: payloadPath,
          ENTROS_MOPRO_BENCH_OUT: outputPath,
        },
        stdio: "pipe",
      },
    );
  } finally {
    fs.rmSync(tmpTestPath, { force: true });
  }

  const moproOut = JSON.parse(fs.readFileSync(outputPath, "utf8")) as {
    coldFullProveMs: number;
    eqChecks: EquivalenceCheckResult[];
    proveMs: number[];
    verifyMs: number[];
    peakRssBytes: number;
  };
  const androidSoPath = path.join(
    moproRoot,
    "MoproReactNativeBindings",
    "android",
    "src",
    "main",
    "jniLibs",
    "arm64-v8a",
    "libentros_mopro.so",
  );
  const nativeArtifactBytes = fs.existsSync(androidSoPath)
    ? fs.statSync(androidSoPath).size
    : undefined;

  return {
    circuitId: "entros_hamming_v1",
    proverBackend: "entros-mopro-arkworks-rust-witness",
    constraints: 2030,
    publicInputs: 4,
    wasmBytes: fs.statSync(
      path.join(moproRoot, "test-vectors", "circom", "entroshamming.wasm"),
    ).size,
    zkeyBytes: fs.statSync(moproZkeyPath).size,
    vkJsonBytes: fs.statSync(VK_PATH).size,
    nativeArtifactBytes,
    solanaProofBytes: 256,
    equivalenceChecksPassed: moproOut.eqChecks.every((c) => c.passed),
    equivalenceChecks: moproOut.eqChecks,
    coldFullProveMs: round3(moproOut.coldFullProveMs),
    warmWitnessMs: null,
    warmFullProveMs: summarizeLatencies(moproOut.proveMs),
    warmVerifyMs: summarizeLatencies(moproOut.verifyMs),
    peakRssBytes: moproOut.peakRssBytes,
    peakHeapUsedBytes: 0,
  };
}

function prepareEphemeralRequestBoundArtifacts(
  circuitsRoot: string,
  tmpDir: string,
): { wasmPath: string; zkeyPath: string; vkPath: string } {
  const circomSource = path.join(
    circuitsRoot,
    "circom",
    "entros_request_bound_v1.circom",
  );
  const ptauPath = path.join(circuitsRoot, "build", "pot12_final.ptau");
  const snarkjsBin = path.join(circuitsRoot, "node_modules", ".bin", "snarkjs");

  execFileSync(
    "circom",
    [circomSource, "--r1cs", "--wasm", "--O1", "-o", tmpDir],
    { cwd: circuitsRoot, stdio: "pipe" },
  );

  const r1csPath = path.join(tmpDir, "entros_request_bound_v1.r1cs");
  const wasmPath = path.join(
    tmpDir,
    "entros_request_bound_v1_js",
    "entros_request_bound_v1.wasm",
  );
  const zkey0Path = path.join(tmpDir, "entros_request_bound_v1_0000.zkey");
  const zkeyPath = path.join(tmpDir, "entros_request_bound_v1_bench.zkey");
  const vkPath = path.join(tmpDir, "verification_key_request_bound.json");

  execFileSync(snarkjsBin, ["groth16", "setup", r1csPath, ptauPath, zkey0Path], {
    cwd: circuitsRoot,
    stdio: "pipe",
  });
  execFileSync(
    snarkjsBin,
    [
      "zkey",
      "contribute",
      zkey0Path,
      zkeyPath,
      "--name=entros-bench-ephemeral",
      "-v",
      "-e=entros-deterministic-benchmark-entropy-2026-10-21",
    ],
    { cwd: circuitsRoot, stdio: "pipe" },
  );
  execFileSync(snarkjsBin, ["zkey", "export", "verificationkey", zkeyPath, vkPath], {
    cwd: circuitsRoot,
    stdio: "pipe",
  });

  return { wasmPath, zkeyPath, vkPath };
}

async function main() {
  const circuitsRoot = path.resolve(__dirname, "..");
  const args = process.argv.slice(2);
  const jsonOutIdx = args.indexOf("--json-out");
  const jsonOutPath =
    jsonOutIdx >= 0 && args[jsonOutIdx + 1]
      ? path.resolve(args[jsonOutIdx + 1])
      : null;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "entros-prover-bench-"));
  try {
    const hammingReport = await benchmarkCircuit({
      circuitId: "entros_hamming_v1",
      constraints: 2030,
      publicInputs: 4,
      wasmPath: WASM_PATH,
      zkeyPath: ZKEY_PATH,
      vkPath: VK_PATH,
      includeRequestDigestLimbs: false,
    });

    const boundArtifacts = prepareEphemeralRequestBoundArtifacts(
      circuitsRoot,
      tmpDir,
    );
    const requestBoundReport = await benchmarkCircuit({
      circuitId: "entros_request_bound_v1",
      constraints: 2290,
      publicInputs: 6,
      wasmPath: boundArtifacts.wasmPath,
      zkeyPath: boundArtifacts.zkeyPath,
      vkPath: boundArtifacts.vkPath,
      includeRequestDigestLimbs: true,
    });

    const maybeCurve = (
      globalThis as { curve_bn128?: { terminate?: () => Promise<void> } }
    ).curve_bn128;
    if (maybeCurve?.terminate) {
      await maybeCurve.terminate();
    }

    const moproReport = await benchmarkMoproArkworks(circuitsRoot, tmpDir);
    const circuitReports = [
      hammingReport,
      requestBoundReport,
      ...(moproReport ? [moproReport] : []),
    ];

    const cpus = os.cpus();
    const suiteReport: ProverBenchmarkSuiteReport = {
      schemaVersion: 1,
      benchmarkId: "entros-client-prover-benchmark-2026-10-21",
      repetitions: REPETITIONS,
      environment: {
        platform: os.platform(),
        arch: os.arch(),
        osRelease: os.release(),
        cpuModel: cpus[0]?.model ?? "unknown",
        cpuCores: cpus.length,
        totalMemoryBytes: os.totalmem(),
        nodeVersion: process.version,
      },
      circuits: circuitReports,
    };

    if (jsonOutPath) {
      fs.mkdirSync(path.dirname(jsonOutPath), { recursive: true });
      fs.writeFileSync(jsonOutPath, JSON.stringify(suiteReport, null, 2) + "\n");
    }

    console.log(JSON.stringify(suiteReport, null, 2));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
