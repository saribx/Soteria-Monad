import { BaseError, ContractFunctionRevertedError } from "viem";

/** Name of the custom error the contract reverted with (NotVerified, BadSignature, …), or null. */
export function revertReason(err: unknown): string | null {
  if (!(err instanceof BaseError)) return null;
  const rev = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (rev instanceof ContractFunctionRevertedError) return rev.data?.errorName ?? rev.reason ?? "reverted";
  return null;
}
