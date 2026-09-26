// Golden P-256 vector produced exactly like the browser does it:
// crypto.subtle.sign({name:'ECDSA', hash:'SHA-256'}, key, rawBytes) -> r||s (64 bytes, P1363).
import { writeFileSync } from "node:fs";
const { subtle } = globalThis.crypto;
const hex = (b) => "0x" + Buffer.from(new Uint8Array(b)).toString("hex");

const kp = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const raw = new Uint8Array(await subtle.exportKey("raw", kp.publicKey)); // 0x04 || x || y
const message = new TextEncoder().encode("who-had-it golden vector: wagon 3, shock 520 cg");
const sig = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, message));

const out = {
  message: hex(message),
  x: hex(raw.slice(1, 33)),
  y: hex(raw.slice(33, 65)),
  r: hex(sig.slice(0, 32)),
  s: hex(sig.slice(32, 64)),
};
writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + "\n");
console.log(out);
