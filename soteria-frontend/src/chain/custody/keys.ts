// WebCrypto P-256 keys: the curve used by passkeys and sensor secure elements.
// Works in the browser and in Node (globalThis.crypto.subtle).
import { bytesToHex, concat, hexToBytes, keccak256, type Hex } from "viem";

export type Sig = { r: Hex; s: Hex };
export type P256Key = { privateKey: CryptoKey; x: Hex; y: Hex; key: Hex };

const subtle = () => globalThis.crypto.subtle;
const ALG = { name: "ECDSA", namedCurve: "P-256" } as const;

/** On-chain party id: keccak256(x ‖ y). Same as Custody.keyOf. */
export const keyOf = (x: Hex, y: Hex): Hex => keccak256(concat([x, y]));

const b64urlToHex = (s: string): Hex => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return bytesToHex(out);
};

async function fromPair(privateKey: CryptoKey, publicKey: CryptoKey): Promise<P256Key> {
  const raw = new Uint8Array(await subtle().exportKey("raw", publicKey)); // 0x04 ‖ x ‖ y
  const x = bytesToHex(raw.slice(1, 33));
  const y = bytesToHex(raw.slice(33, 65));
  return { privateKey, x, y, key: keyOf(x, y) };
}

export async function generateKey(extractable = true): Promise<P256Key> {
  const kp = await subtle().generateKey(ALG, extractable, ["sign", "verify"]);
  return fromPair(kp.privateKey, kp.publicKey);
}

export async function exportJwk(k: P256Key): Promise<JsonWebKey> {
  return subtle().exportKey("jwk", k.privateKey);
}

export async function importJwk(jwk: JsonWebKey): Promise<P256Key> {
  const privateKey = await subtle().importKey("jwk", jwk, ALG, true, ["sign"]);
  const x = b64urlToHex(jwk.x!);
  const y = b64urlToHex(jwk.y!);
  return { privateKey, x, y, key: keyOf(x, y) };
}

/** Signs the raw message bytes. WebCrypto applies SHA-256; do not hash beforehand. */
export async function sign(k: P256Key, message: Hex): Promise<Sig> {
  const sig = new Uint8Array(await subtle().sign({ name: "ECDSA", hash: "SHA-256" }, k.privateKey, new Uint8Array(hexToBytes(message))));
  return { r: bytesToHex(sig.slice(0, 32)), s: bytesToHex(sig.slice(32, 64)) };
}
