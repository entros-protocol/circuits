import { expect } from "chai";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as snarkjs from "snarkjs";
import { generateValidInput } from "./test_vectors";

for (const optimization of ["O1", "O2"]) {
  describe(`Request-bound circuit ${optimization}`, function () {
    this.timeout(120000);
    let directory: string;
    let wasm: string;
    let r1cs: string;
    let sequence = 0;

    before(() => {
      directory = mkdtempSync(join(tmpdir(), "entros-bound-circuit-test-"));
      execFileSync("circom", [
        resolve("circom/entros_request_bound_v1.circom"),
        "--r1cs",
        "--wasm",
        `--${optimization}`,
        "-o",
        directory,
      ]);
      r1cs = join(directory, "entros_request_bound_v1.r1cs");
      wasm = join(
        directory,
        "entros_request_bound_v1_js/entros_request_bound_v1.wasm",
      );
    });

    it("keeps both public digest limbs in nonlinear constraints", async () => {
      const relation = await snarkjs.r1cs.exportJson(r1cs);
      expect(relation.nPubInputs).to.equal(6);
      for (const wire of ["5", "6"]) {
        expect(
          relation.constraints.some(
            ([left, right]) =>
              left[wire] !== undefined && right[wire] !== undefined,
          ),
        ).to.equal(true);
      }
    });

    it("preserves the six-input order at both digest boundaries", async () => {
      for (const limb of ["0", ((1n << 128n) - 1n).toString()]) {
        const base = await generateValidInput();
        const input = {
          ...base,
          request_digest_hi: limb,
          request_digest_lo: limb,
        };
        const witness = join(directory, `valid-${sequence++}.wtns`);
        await snarkjs.wtns.calculate(input, wasm, witness);
        expect(await snarkjs.wtns.check(r1cs, witness)).to.equal(true);
        const values = await snarkjs.wtns.exportJson(witness);
        expect(values.slice(1, 7).map(String)).to.deep.equal([
          base.commitment_new,
          base.commitment_prev,
          base.threshold,
          base.min_distance,
          limb,
          limb,
        ]);
      }
    });

    it("rejects invalid witnesses and digest limbs", async () => {
      const base = {
        ...(await generateValidInput()),
        request_digest_hi: "1",
        request_digest_lo: "2",
      };
      for (const mutation of [
        { request_digest_hi: (1n << 128n).toString() },
        { request_digest_lo: (1n << 128n).toString() },
        { request_digest_hi: "-1" },
        { commitment_new: "123" },
        { threshold: "512" },
        { threshold: "3" },
        { min_distance: "11" },
      ]) {
        const witness = { type: "mem" as const };
        let rejected = false;
        try {
          await snarkjs.wtns.calculate({ ...base, ...mutation }, wasm, witness);
          rejected = !(await snarkjs.wtns.check(r1cs, witness));
        } catch (error) {
          expect(error).to.be.instanceOf(Error);
          expect((error as Error).message).to.include("Assert Failed");
          rejected = true;
        }
        expect(rejected, JSON.stringify(mutation)).to.equal(true);
      }
    });
  });
}
