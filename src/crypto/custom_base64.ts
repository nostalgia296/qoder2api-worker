export const CUSTOM_ALPHABET =
  "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const STD_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CUSTOM_PAD = "$";

const S2C: Record<string, string> = {};
const C2S: Record<string, string> = {};
for (let i = 0; i < 64; i++) {
  S2C[STD_ALPHABET[i]!] = CUSTOM_ALPHABET[i]!;
  C2S[CUSTOM_ALPHABET[i]!] = STD_ALPHABET[i]!;
}
S2C["="] = CUSTOM_PAD;
C2S[CUSTOM_PAD] = "=";

export function encode(plain: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < plain.length; i++) {
    bin += String.fromCharCode(plain[i]!);
  }
  const std = btoa(bin);
  const n = std.length;
  const a = Math.floor(n / 3);
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  let result = "";
  for (const ch of rearranged) {
    const m = S2C[ch];
    if (m === undefined) throw new Error(`char out of alphabet: ${ch}`);
    result += m;
  }
  return result;
}

export function decode(encoded: string): Uint8Array {
  const n = encoded.length;
  let mapped = "";
  for (const ch of encoded) {
    const m = C2S[ch];
    if (m === undefined) {
      throw new Error(`char out of custom alphabet: ${ch}`);
    }
    mapped += m;
  }
  const a = Math.floor(n / 3);
  const std =
    mapped.slice(n - a) + mapped.slice(a, n - a) + mapped.slice(0, a);
  const bin = atob(std);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
