import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { expect } from "chai";

const testRoot = dirname(fileURLToPath(import.meta.url));
const parser = resolve(testRoot, "../scripts/parse_constraint_count.sh");

describe("setup constraint parser", () => {
  it("ignores ANSI colour parameters", () => {
    const output = execFileSync("bash", [parser], {
      input: "\u001b[32;22m[INFO] snarkJS\u001b[0m: # of Constraints: 2030\n",
      encoding: "utf8",
    });

    expect(output.trim()).to.equal("2030");
  });

  it("fails when snarkjs does not report a constraint count", () => {
    const result = spawnSync("bash", [parser], {
      input: "snarkJS: no constraint result\n",
      encoding: "utf8",
    });

    expect(result.status).to.equal(1);
    expect(result.stderr).to.contain("Could not parse");
  });
});
