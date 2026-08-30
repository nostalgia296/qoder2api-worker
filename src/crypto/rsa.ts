export type Rng = (count: number) => Uint8Array;

const E = 65537n;

export function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const b of bytes) result = (result << 8n) | BigInt(b);
  return result;
}

export function bigIntToBytes(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    if (exp > 0n) base = (base * base) % mod;
  }
  return result;
}

interface DerElement {
  tag: number;
  content: Uint8Array;
  end: number;
}

function readDerElement(der: Uint8Array, pos: number): DerElement {
  const tag = der[pos]!;
  let lenByte = der[pos + 1]!;
  pos += 2;
  let len = lenByte;
  if (lenByte & 0x80) {
    const numBytes = lenByte & 0x7f;
    len = 0;
    for (let i = 0; i < numBytes; i++) {
      len = len * 256 + der[pos]!;
      pos++;
    }
  }
  return { tag, content: der.slice(pos, pos + len), end: pos + len };
}

export function parsePemPublicModulus(pem: string): {
  modulus: bigint;
  keyLen: number;
} {
  const b64 = pem.replace(/-----(BEGIN|END)[^-]+-----/g, "").replace(/\s/g, "");
  const bin = atob(b64);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);

  const root = readDerElement(der, 0);
  const alg = readDerElement(root.content, 0);
  const bitStr = readDerElement(root.content, alg.end);
  const rsaKey = readDerElement(bitStr.content, 1);
  const nEl = readDerElement(rsaKey.content, 0);
  const modulus = bytesToBigInt(nEl.content);
  const keyLen = (modulus.toString(2).length + 7) >> 3;
  return { modulus, keyLen };
}

function randomNonZeroBytes(count: number): Uint8Array {
  const out = new Uint8Array(count);
  const buf = new Uint8Array(Math.max(count * 2, 16));
  let filled = 0;
  while (filled < count) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b !== 0 && filled < count) out[filled++] = b;
    }
  }
  return out;
}

export function pkcs1Pad(
  message: Uint8Array,
  k: number,
  rng: Rng = randomNonZeroBytes,
): Uint8Array {
  if (message.length > k - 11) {
    throw new Error("message too long for PKCS1 v1.5 padding");
  }
  const psLen = k - message.length - 3;
  const ps = rng(psLen);
  for (const b of ps) {
    if (b === 0) throw new Error("RNG produced zero byte in padding");
  }
  const em = new Uint8Array(k);
  em[0] = 0x00;
  em[1] = 0x02;
  em.set(ps, 2);
  em[2 + psLen] = 0x00;
  em.set(message, 3 + psLen);
  return em;
}

export function rsaPkcs1Encrypt(
  message: Uint8Array,
  modulus: bigint,
  keyLen: number,
  rng?: Rng,
): Uint8Array {
  const em = pkcs1Pad(message, keyLen, rng);
  const c = modPow(bytesToBigInt(em), E, modulus);
  return bigIntToBytes(c, keyLen);
}
