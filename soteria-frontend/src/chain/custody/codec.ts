// JSON with bigints, for the browser → relay request body. 123n <-> "123n".
export const toJson = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));

export const fromJson = <T = unknown>(s: string): T =>
  JSON.parse(s, (_k, x) => (typeof x === "string" && /^-?\d+n$/.test(x) ? BigInt(x.slice(0, -1)) : x));
