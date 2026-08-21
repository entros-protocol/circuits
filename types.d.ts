declare module "snarkjs" {
  export interface Groth16Proof {
    pi_a: [string, string, string?];
    pi_b: [[string, string], [string, string], [string, string]?];
    pi_c: [string, string, string?];
    protocol?: string;
    curve?: string;
  }

  export const zKey: {
    exportVerificationKey(zkeyPath: string): Promise<unknown>;
  };

  export const groth16: {
    fullProve(
      input: object,
      wasmPath: string,
      zkeyPath: string
    ): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
    verify(
      vk: unknown,
      publicSignals: string[],
      proof: Groth16Proof
    ): Promise<boolean>;
  };
}
