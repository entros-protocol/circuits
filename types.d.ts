declare module "snarkjs" {
  export const zKey: {
    exportVerificationKey(zkeyPath: string): Promise<unknown>;
  };

  export const groth16: {
    fullProve(
      input: any,
      wasmPath: string,
      zkeyPath: string
    ): Promise<{ proof: any; publicSignals: string[] }>;
    verify(
      vk: any,
      publicSignals: string[],
      proof: any
    ): Promise<boolean>;
  };
}
