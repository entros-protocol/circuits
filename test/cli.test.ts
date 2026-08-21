import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect } from "chai";

import { generateValidInput } from "./test_vectors";

describe("circuit command wrappers", function () {
  this.timeout(120000);

  it("generates and verifies a proof with the local test key", async () => {
    const directory = mkdtempSync(join(tmpdir(), "entros-circuit-cli-"));
    try {
      const input = join(directory, "input.json");
      const proof = join(directory, "proof.json");
      const publicSignals = join(directory, "public.json");
      writeFileSync(input, JSON.stringify(await generateValidInput(10, 30, 3)));

      execFileSync("bash", [resolve("scripts/prove.sh"), input, proof, publicSignals]);
      const output = execFileSync(
        "bash",
        [resolve("scripts/verify.sh"), proof, publicSignals],
        { encoding: "utf8" },
      );

      expect(output).to.contain("OK");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
