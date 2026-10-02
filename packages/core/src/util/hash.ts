/**
 * Pure SHA-256 (FIPS 180-4) and canonical JSON, so hashing works the same in the server, the
 * browser (audit verification), and tests without Node APIs.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** UTF-8 encode without TextEncoder (core targets plain ES, no DOM or Node globals). */
export function utf8(text: string): Uint8Array {
  const out: number[] = [];
  for (const char of text) {
    const cp = char.codePointAt(0) as number;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 63),
        0x80 | ((cp >> 6) & 63),
        0x80 | (cp & 63),
      );
  }
  return Uint8Array.from(out);
}

/** SHA-256 of a UTF-8 string (or bytes), as lowercase hex. */
export function sha256(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? utf8(input) : input;
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 2 ** 32));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15] as number;
      const w2 = w[i - 2] as number;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e as number, 6) ^ rotr(e as number, 11) ^ rotr(e as number, 25);
      const ch = ((e as number) & (f as number)) ^ (~(e as number) & (g as number));
      const t1 = ((hh as number) + S1 + ch + (K[i] as number) + (w[i] as number)) >>> 0;
      const S0 = rotr(a as number, 2) ^ rotr(a as number, 13) ^ rotr(a as number, 22);
      const maj =
        ((a as number) & (b as number)) ^
        ((a as number) & (c as number)) ^
        ((b as number) & (c as number));
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = ((d as number) + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = ((h[0] as number) + (a as number)) >>> 0;
    h[1] = ((h[1] as number) + (b as number)) >>> 0;
    h[2] = ((h[2] as number) + (c as number)) >>> 0;
    h[3] = ((h[3] as number) + (d as number)) >>> 0;
    h[4] = ((h[4] as number) + (e as number)) >>> 0;
    h[5] = ((h[5] as number) + (f as number)) >>> 0;
    h[6] = ((h[6] as number) + (g as number)) >>> 0;
    h[7] = ((h[7] as number) + (hh as number)) >>> 0;
  }
  return [...h].map((x) => x.toString(16).padStart(8, '0')).join('');
}

/**
 * Canonical JSON: object keys sorted, `undefined` members dropped, no whitespace. Equal values
 * always serialize identically, which is what hash chains and edit hashes need.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Hash-chain genesis and link (docs/data-model.md § Hash chain). */
export function chainGenesis(graphId: string | null): string {
  return sha256(`agent-graphs:${graphId ?? 'global'}`);
}

export type ChainedEvent = {
  id: string;
  seq: number;
  graphId: string | null;
  type: string;
  entityType: string;
  entityId: string;
  actor: unknown;
  payload: unknown;
  createdAt: number | string;
};

export function chainHash(prevHash: string, event: ChainedEvent): string {
  const { id, seq, graphId, type, entityType, entityId, actor, payload, createdAt } = event;
  return sha256(
    `${prevHash}\n${canonicalJson({ id, seq, graphId, type, entityType, entityId, actor, payload, createdAt })}`,
  );
}

/** Recompute a chain; returns the index of the first mismatch, or -1. */
export function verifyChain(
  graphId: string | null,
  events: Array<ChainedEvent & { prevHash: string; hash: string }>,
): number {
  let prev = chainGenesis(graphId);
  for (let i = 0; i < events.length; i++) {
    const e = events[i] as ChainedEvent & { prevHash: string; hash: string };
    if (e.prevHash !== prev || chainHash(prev, e) !== e.hash) return i;
    prev = e.hash;
  }
  return -1;
}
