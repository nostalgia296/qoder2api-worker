
export function uuid() {
  return crypto.randomUUID();
}

export function bytesToB64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function strToB64(s) {
  return bytesToB64(new TextEncoder().encode(s));
}

export async function aesCbcEncrypt(keyBytes, ivBytes, dataBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: ivBytes }, key, dataBytes);
  return new Uint8Array(ct);
}

const RSA_N = 0xc0f22307e5cd362e296bb04470f6de8fbf935ce24e8fcf511a0e2701329769c4a76e499bb938036a52af1eaf818cf79a2600620e3ce87e371d2ca6d85803606a1b3fa5e874643c9ed2db7e85673ef7227fca56e2e7c08f0927609bb896a9f24be1782099a66016a5bfdc3f1ff756bfc9e88d7b5dc5be30bf45a0223a00ebcecfn;
const RSA_E = 65537n;
const RSA_K = 128; 

function modPow(base, exp, mod) {
  let r = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) r = r * base % mod;
    base = base * base % mod;
    exp >>= 1n;
  }
  return r;
}

export function rsaPkcs1v15Encrypt(msg) {
  if (msg.length > RSA_K - 11) throw new Error('RSA message too long');
  const em = new Uint8Array(RSA_K);
  em[0] = 0;
  em[1] = 2;
  const psLen = RSA_K - 3 - msg.length;
  const one = new Uint8Array(1);
  for (let i = 0; i < psLen; i++) {
    let v = 0;
    while (v === 0) { crypto.getRandomValues(one); v = one[0]; }
    em[2 + i] = v;
  }
  em[2 + psLen] = 0;
  em.set(msg, 3 + psLen);
  let m = 0n;
  for (const byte of em) m = (m << 8n) | BigInt(byte);
  let c = modPow(m, RSA_E, RSA_N);
  const out = new Uint8Array(RSA_K);
  for (let i = RSA_K - 1; i >= 0; i--) {
    out[i] = Number(c & 0xffn);
    c >>= 8n;
  }
  return out;
}
