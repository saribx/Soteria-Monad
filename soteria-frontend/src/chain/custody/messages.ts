// Canonical encoding of every signed message. Must match Custody.sol byte for byte:
// abi.encodePacked(chainId, contract, op, ...fields). Sign the returned bytes as-is with
// keys.ts `sign` (WebCrypto hashes with SHA-256; the contract runs sha256 once). Never pre-hash.
import { concat, encodeAbiParameters, encodePacked, keccak256, sha256, type Address, type Hex } from "viem";

export const OP = { create: 1, batch: 2, handover: 3, alarm: 4, keys: 5 } as const;
export const ROLE = { shipper: 1, carrier: 2, receiver: 3, wagon: 4 } as const;
export const STATUS = { green: 0, amber: 1, red: 2 } as const;
export const KIND_SHOCK = 1;

export type Ctx = { chainId: number | bigint; contract: Address };

/** Amounts are tEUR cents. shockLimitCg is centi-g (520 = 5.20 g). expiry is unix seconds. */
export type Terms = {
  shipper: Hex;
  carrier: Hex;
  receiver: Hex;
  penalty: bigint;
  cap: bigint;
  shockLimitCg: number;
  expiry: bigint;
};

export function createMessage(ctx: Ctx, id: bigint, t: Terms, wagonKeys: Hex[]): Hex {
  return encodePacked(
    ["uint256", "address", "uint8", "uint256", "bytes32", "bytes32", "bytes32", "uint64", "uint64", "uint16", "bytes32", "uint64"],
    [
      BigInt(ctx.chainId), ctx.contract, OP.create, id,
      t.shipper, t.carrier, t.receiver, t.penalty, t.cap, t.shockLimitCg,
      keccak256(wagonKeys.length ? concat(wagonKeys) : "0x"), t.expiry,
    ],
  );
}

/** Giver (current holder) and receiver both sign these same bytes. */
export function handoverMessage(
  ctx: Ctx, id: bigint, epoch: number, from: Hex, to: Hex, reservation: Hex, expiry: bigint,
): Hex {
  return encodePacked(
    ["uint256", "address", "uint8", "uint256", "uint32", "bytes32", "bytes32", "bytes32", "uint64"],
    [BigInt(ctx.chainId), ctx.contract, OP.handover, id, epoch, from, to, reservation, expiry],
  );
}

/** Signed by the wagon key. Covers sha256(ciphertext), so the payload cannot be swapped. */
export function batchMessage(
  ctx: Ctx, id: bigint, wagon: number, epoch: number, seq: bigint, root: Hex, status: number, ciphertext: Hex,
): Hex {
  return encodePacked(
    ["uint256", "address", "uint8", "uint256", "uint8", "uint32", "uint64", "bytes32", "uint8", "bytes32"],
    [BigInt(ctx.chainId), ctx.contract, OP.batch, id, wagon, epoch, seq, root, status, sha256(ciphertext)],
  );
}

export function alarmMessage(
  ctx: Ctx, id: bigint, epoch: number, wagon: number, alarmId: bigint, kind: number, valueCg: number,
): Hex {
  return encodePacked(
    ["uint256", "address", "uint8", "uint256", "uint32", "uint8", "uint64", "uint8", "uint16"],
    [BigInt(ctx.chainId), ctx.contract, OP.alarm, id, epoch, wagon, alarmId, kind, valueCg],
  );
}

/** Signed by the shipper or the current holder when publishing wrapped per-epoch data keys. */
export function keysMessage(
  ctx: Ctx, id: bigint, epoch: number, signer: Hex, partyKeys: Hex[], wrapped: Hex[],
): Hex {
  const bundle = keccak256(encodeAbiParameters([{ type: "bytes32[]" }, { type: "bytes[]" }], [partyKeys, wrapped]));
  return encodePacked(
    ["uint256", "address", "uint8", "uint256", "uint32", "bytes32", "bytes32"],
    [BigInt(ctx.chainId), ctx.contract, OP.keys, id, epoch, signer, bundle],
  );
}
