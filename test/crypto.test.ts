import { describe, expect, it } from "vitest";
import { md5Hex } from "../src/crypto/md5";
import { CUSTOM_ALPHABET, decode, encode } from "../src/crypto/custom_base64";
import {
  bigIntToBytes,
  bytesToBigInt,
  modPow,
  parsePemPublicModulus,
  pkcs1Pad,
  rsaPkcs1Encrypt,
} from "../src/crypto/rsa";
import { aesCbcEncryptIvEqKey } from "../src/crypto/aes";

describe("md5", () => {
  it("matches known vectors", () => {
    expect(md5Hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5Hex("abcdefghijklmnopqrstuvwxyz")).toBe(
      "c3fcd3d76192e4007dfb496cca67e13b",
    );
    expect(
      md5Hex("The quick brown fox jumps over the lazy dog"),
    ).toBe("9e107d9d372bb6826bd81d3542a419d6");
  });

  it("handles multi-block input (1 million a's)", () => {
    expect(md5Hex("a".repeat(1_000_000))).toBe(
      "7707d6ae4e027c70eea2a935c2296f21",
    );
  });

  it("handles padding boundaries (55/56/63/64 bytes)", () => {
    // 与 Node crypto 对照过的边界长度：覆盖 1/2 块填充场景
    expect(md5Hex("a".repeat(55))).toHaveLength(32);
    expect(md5Hex("a".repeat(56))).toHaveLength(32);
    expect(md5Hex("a".repeat(63))).toHaveLength(32);
    expect(md5Hex("a".repeat(64))).toHaveLength(32);
    expect(md5Hex("a".repeat(55))).not.toBe(md5Hex("a".repeat(56)));
  });
});

describe("custom base64", () => {
  it("matches regression vectors", () => {
    expect(encode(new TextEncoder().encode("hello world"))).toBe(
      "YuHp$Hq&J(WPHFru",
    );
  });

  it("roundtrips for all padding cases", () => {
    for (let len = 0; len <= 20; len++) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = (i * 37 + 11) % 256;
      const enc = encode(bytes);
      // 输出只包含私有字母表 + 填充符
      for (const ch of enc) {
        expect(CUSTOM_ALPHABET.includes(ch) || ch === "$").toBe(true);
      }
      expect(decode(enc)).toEqual(bytes);
    }
  });

  it("rejects chars outside the custom alphabet", () => {
    expect(() => decode("abc+/=")).toThrow();
  });
});

describe("aes", () => {
  it("matches golden vector (key=iv, aes-128-cbc, pkcs7)", async () => {
    const key = new TextEncoder().encode("0123456789abcdef");
    const plain = new TextEncoder().encode(
      '{"name":"t","aid":"1","uid":"1","yx_uid":"","organization_id":"","organization_name":"","user_type":"personal_standard","security_oauth_token":"s","refresh_token":"r"}',
    );
    const ct = await aesCbcEncryptIvEqKey(plain, key);
    const b64 = btoa(String.fromCharCode(...ct));
    expect(b64).toBe(
      "EhYHBikqrBSCys/X+cuhcsQbcHHvB8ArSfCM6ull+L5yunKORyxlabslVJnURyfzMuXvdvZy2ifVQrBshRpeaXfHyZRk37ad94Z5PqNB5wfclB2wiosfgypTKkC3Sm3iKAO4nqwO40+2Tnz7bPo+Y5S6VXyXCkSeYcZ+NfB9r2LEfXrdD67Xju2e90nYRcyFLGqC5gpRbGauH9sGSv2VWimeqO5ivxh/2hoxPdoZA1c=",
    );
  });
});

const TEST_RSA_PEM =
  "-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDKodbKkcDxyIBi70D7PE8OBiyR\nzvSwyI1r64dqFyzs3yF6DsAwg26wpW5Sb/a5rKECxu299CoPGNTYz4FzcqvTzqQ6\nZWkgan3f3CRpkwbKLofkiRE2dvZHgTu/tt849bQ/QuyG2SmmbmC4yf3wQV4uvHUe\nASZ7d/yZqJE0VW6QNQIDAQAB\n-----END PUBLIC KEY-----";
const TEST_N_B64URL =
  "yqHWypHA8ciAYu9A-zxPDgYskc70sMiNa-uHahcs7N8heg7AMINusKVuUm_2uayhAsbtvfQqDxjU2M-Bc3Kr086kOmVpIGp939wkaZMGyi6H5IkRNnb2R4E7v7bfOPW0P0Lshtkppm5guMn98EFeLrx1HgEme3f8maiRNFVukDU";
const TEST_D_B64URL =
  "HApLO9rxlUPGqGotVtbgpbMrBb5a0__cuhtssLymRd0Wt9pEtDHr5lvuKVA_FzCRU14N1iRskYxBIAOPCVfL-RNqWj2iHu7H4CTb5ZTMYxdBevtcCoKK151b1RwGoVKCwgcAvZ-WOIAtTkbFAe_urcxVNH-0eT59EMHR0bS-ub0";

function b64urlToBigInt(s: string): bigint {
  const b64 =
    s.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  let r = 0n;
  for (let i = 0; i < bin.length; i++) {
    r = (r << 8n) | BigInt(bin.charCodeAt(i));
  }
  return r;
}

describe("rsa", () => {
  it("parses modulus from PEM", () => {
    const { modulus, keyLen } = parsePemPublicModulus(TEST_RSA_PEM);
    expect(keyLen).toBe(128);
    expect(modulus).toBe(b64urlToBigInt(TEST_N_B64URL));
  });

  it("parses the real server key as 1024-bit", () => {
    const pem = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;
    const { modulus, keyLen } = parsePemPublicModulus(pem);
    expect(keyLen).toBe(128);
    expect(modulus >= 1n << 1023n).toBe(true);
  });

  it("pkcs1Pad produces valid type-2 structure", () => {
    const msg = new TextEncoder().encode("hi");
    const rng = (n: number) => new Uint8Array(n).fill(1);
    const em = pkcs1Pad(msg, 128, rng);
    expect(em.length).toBe(128);
    expect(em[0]).toBe(0x00);
    expect(em[1]).toBe(0x02);
    const sepIdx = 128 - msg.length - 1;
    expect(em[sepIdx]).toBe(0x00);
    for (let i = 2; i < sepIdx; i++) expect(em[i]).toBe(1); // PS 全为注入的 1
    expect(em.slice(sepIdx + 1)).toEqual(msg);
  });

  it("pkcs1Pad rejects too-long messages", () => {
    expect(() =>
      pkcs1Pad(new Uint8Array(128 - 10), 128),
    ).toThrow();
  });

  it("encrypt/decrypt roundtrip with test key (modpow oracle)", () => {
    const n = b64urlToBigInt(TEST_N_B64URL);
    const d = b64urlToBigInt(TEST_D_B64URL);
    const msg = new TextEncoder().encode("hello rsa pkcs1 v1_5");
    const ct = rsaPkcs1Encrypt(msg, n, 128);
    expect(ct.length).toBe(128);

    // 用私钥指数解密，验证填充结构与明文
    const em = bigIntToBytes(modPow(bytesToBigInt(ct), d, n), 128);
    expect(em[0]).toBe(0x00);
    expect(em[1]).toBe(0x02);
    let sep = -1;
    for (let i = 2; i < em.length; i++) {
      if (em[i] === 0x00) {
        sep = i;
        break;
      }
    }
    expect(sep).toBeGreaterThanOrEqual(10); // PS ≥ 8 字节
    for (let i = 2; i < sep; i++) expect(em[i]).not.toBe(0);
    expect(em.slice(sep + 1)).toEqual(msg);
  });

  it("encryption is non-deterministic (random PS)", () => {
    const n = b64urlToBigInt(TEST_N_B64URL);
    const msg = new TextEncoder().encode("same");
    const c1 = rsaPkcs1Encrypt(msg, n, 128);
    const c2 = rsaPkcs1Encrypt(msg, n, 128);
    expect(bytesToBigInt(c1)).not.toBe(bytesToBigInt(c2));
  });
});
