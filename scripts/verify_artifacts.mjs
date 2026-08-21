import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(readFileSync(join(root, "circuit-lock.json"), "utf8"));

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function requireEqual(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${expected}, received ${actual}`);
  }
}

if (lock.schema !== 1) {
  throw new Error("Unsupported circuit lock schema.");
}

const r1cs = join(root, "build", "entros_hamming.r1cs");
const wasm = join(root, "build", "entros_hamming_js", "entros_hamming.wasm");
const keyJson = join(root, "keys", "verification_key.json");
const keyRust = join(root, "keys", "verifying_key.rs");
const snarkjs = join(root, "node_modules", ".bin", "snarkjs");

requireEqual("R1CS SHA-256", sha256(r1cs), lock.artifacts.r1csSha256);
requireEqual("WASM SHA-256", sha256(wasm), lock.artifacts.wasmSha256);
requireEqual(
  "verification key JSON SHA-256",
  sha256(keyJson),
  lock.artifacts.verificationKeyJsonSha256,
);
requireEqual(
  "verification key Rust SHA-256",
  sha256(keyRust),
  lock.artifacts.verificationKeyRustSha256,
);

const info = execFileSync(snarkjs, ["r1cs", "info", r1cs], {
  encoding: "utf8",
});
const normalizedInfo = info.replace(/\u001b\[[0-9;]*m/g, "");
const constraintMatch = normalizedInfo.match(/# of Constraints:\s*([0-9]+)/);
if (!constraintMatch) {
  throw new Error("snarkjs did not report the circuit constraint count.");
}
requireEqual(
  "constraint count",
  Number.parseInt(constraintMatch[1], 10),
  lock.artifacts.constraintCount,
);

const temporaryDirectory = mkdtempSync(join(tmpdir(), "entros-vk-parity-"));
try {
  execFileSync(
    process.execPath,
    [join(root, "scripts", "parse_vk_to_rust.js"), keyJson, temporaryDirectory],
    { stdio: "pipe" },
  );
  requireEqual(
    "verification key Rust serialization",
    readFileSync(join(temporaryDirectory, "verifying_key.rs"), "utf8"),
    readFileSync(keyRust, "utf8"),
  );
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

console.log("Circuit artifacts match circuit-lock.json.");
