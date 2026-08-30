export async function aesCbcEncryptIvEqKey(
  plain: Uint8Array,
  key: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "AES-CBC" },
    false,
    ["encrypt"],
  );
  const ct = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: key as BufferSource },
    cryptoKey,
    plain as BufferSource,
  );
  return new Uint8Array(ct);
}
