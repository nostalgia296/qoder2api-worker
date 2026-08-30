import { encode } from "./crypto/custom_base64";
import { md5Hex } from "./crypto/md5";
import { parsePemPublicModulus, rsaPkcs1Encrypt } from "./crypto/rsa";
import { aesCbcEncryptIvEqKey } from "./crypto/aes";

export interface RegionConfig {
  name: string;
  authBase: string;
  chatBase: string;
}

export const CN: RegionConfig = {
  name: "cn",
  authBase: "https://gateway.qoder.com.cn",
  chatBase: "https://gateway.qoder.com.cn",
};

export function resolve(pat: string): { pat: string; region: RegionConfig } {
  return { pat, region: CN };
}

export function authUrl(region: RegionConfig, path: string): string {
  return `${region.authBase}${path}`;
}

export function chatUrl(region: RegionConfig): string {
  return (
    `${region.chatBase}/algo/api/v2/service/pro/sse/agent_chat_generation` +
    "?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1"
  );
}

export function modelListUrl(region: RegionConfig): string {
  return `${region.chatBase}/algo/api/v2/model/list?Encode=1`;
}

export async function fetchModelCatalog(
  sess: SessionContext,
  region: RegionConfig,
): Promise<unknown> {
  return callGet(sess, modelListUrl(region));
}

export const APPCODE = "cosy";
export const DEFAULT_SECRET = "d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==";
const SEP = "&";

export function currentDate(): string {
  return new Date().toUTCString();
}

export function sign(date: string, secret: string): string {
  return md5Hex(`${APPCODE}${SEP}${secret}${SEP}${date}`);
}

const SERVER_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

const { modulus: SERVER_MODULUS, keyLen: SERVER_KEY_LEN } =
  parsePemPublicModulus(SERVER_PUBKEY_PEM);

export interface AuthIdentity {
  name: string;
  aid: string;
  uid: string;
  yxUid: string;
  organizationId: string;
  organizationName: string;
  userType: string;
  securityOauthToken: string;
  refreshToken: string;
}

export interface SessionContext {
  tempKey: Uint8Array;
  cosyKey: string;
  info: string;
  identity: AuthIdentity;
  machineId: string;
  machineToken: string;
  machineType: string;
}

export class QoderAuthError extends Error {
  constructor(
    public statusCode: number,
    public detail: string = "",
  ) {
    super(`HTTP ${statusCode} ${detail}`.trim());
    this.name = "QoderAuthError";
  }
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return btoa(bin);
}

function authPayloadJson(identity: AuthIdentity): Uint8Array {
  const payload = {
    name: identity.name,
    aid: identity.aid,
    uid: identity.uid,
    yx_uid: identity.yxUid,
    organization_id: identity.organizationId,
    organization_name: identity.organizationName,
    user_type: identity.userType,
    security_oauth_token: identity.securityOauthToken,
    refresh_token: identity.refreshToken,
  };
  return new TextEncoder().encode(JSON.stringify(payload));
}

export async function newSession(
  identity: AuthIdentity,
  machineId: string,
  machineToken: string,
  machineType: string,
): Promise<SessionContext> {
  const tempKey = new TextEncoder().encode(
    crypto.randomUUID().replace(/-/g, "").slice(0, 16),
  );
  const cosyKey = bytesToB64(
    rsaPkcs1Encrypt(tempKey, SERVER_MODULUS, SERVER_KEY_LEN),
  );
  const info = bytesToB64(await aesCbcEncryptIvEqKey(authPayloadJson(identity), tempKey));
  return {
    tempKey,
    cosyKey,
    info,
    identity,
    machineId,
    machineToken,
    machineType,
  };
}

export function signRequest(
  payloadB64: string,
  cosyKey: string,
  cosyDate: string,
  body: string,
  pathWithoutAlgo: string,
): string {
  return md5Hex(
    `${payloadB64}\n${cosyKey}\n${cosyDate}\n${body}\n${pathWithoutAlgo}`,
  );
}

export function buildPayloadB64(info: string): string {
  const m = {
    cosyVersion: "0.1.43",
    ideVersion: "",
    info,
    requestId: crypto.randomUUID(),
    version: "v1",
  };
  return bytesToB64(new TextEncoder().encode(JSON.stringify(m)));
}

export function composeBearer(payloadB64: string, sig: string): string {
  return `Bearer COSY.${payloadB64}.${sig}`;
}

function commonSignatureHeaders(
  machineId: string,
  machineToken: string,
  machineType: string,
  date: string,
  sig: string,
): Record<string, string> {
  return {
    "cosy-machinetoken": machineToken,
    "cosy-machinetype": machineType,
    "login-version": "v2",
    appcode: APPCODE,
    accept: "application/json",
    "accept-encoding": "identity",
    "cosy-version": "0.1.43",
    "cosy-clienttype": "5",
    date,
    signature: sig,
    "content-type": "application/json",
    "cosy-machineid": machineId,
    "user-agent": "Go-http-client/2.0",
  };
}

export interface MachineIdentity {
  machineId: string;
  machineToken: string;
  machineType: string;
}

async function postEncoded(
  url: string,
  obj: Record<string, unknown>,
  machine: MachineIdentity,
  secret: string,
): Promise<any> {
  const date = currentDate();
  const sig = sign(date, secret);
  const plain = new TextEncoder().encode(JSON.stringify(obj));
  const body = encode(plain);
  const headers = commonSignatureHeaders(
    machine.machineId,
    machine.machineToken,
    machine.machineType,
    date,
    sig,
  );

  const resp = await fetch(url, {
    method: "POST",
    body,
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (resp.status !== 200) {
    const detail = (await resp.text()).slice(0, 300);
    if (resp.status === 401 || resp.status === 403) {
      throw new QoderAuthError(resp.status, detail);
    }
    throw new Error(`HTTP ${resp.status} at ${url} body=${detail}`);
  }
  return resp.json();
}

async function requestJobToken(
  personalToken: string,
  refreshToken: string,
  securityOauthToken: string,
  needRefresh: boolean,
  machine: MachineIdentity,
  region: RegionConfig,
  secret: string,
): Promise<any> {
  const url = authUrl(region, "/algo/api/v3/user/jobToken?Encode=1");
  const inner = {
    personalToken,
    securityOauthToken,
    refreshToken,
    needRefresh,
    authInfo: {},
  };
  const outer = {
    payload: JSON.stringify(inner),
    encodeVersion: "1",
  };
  return postEncoded(url, outer, machine, secret);
}

export function exchangeJobToken(
  personalToken: string,
  machine: MachineIdentity,
  region: RegionConfig,
  secret: string,
): Promise<any> {
  return requestJobToken(
    personalToken,
    "",
    "",
    false,
    machine,
    region,
    secret,
  );
}

export function refreshJobToken(
  personalToken: string,
  refreshToken: string,
  securityOauthToken: string,
  machine: MachineIdentity,
  region: RegionConfig,
  secret: string,
): Promise<any> {
  return requestJobToken(
    personalToken,
    refreshToken,
    securityOauthToken,
    true,
    machine,
    region,
    secret,
  );
}

function commonBearerHeaders(
  sess: SessionContext,
  date: string,
  bearer: string,
  accept: string,
): Record<string, string> {
  return {
    "cosy-data-policy": "AGREE",
    "content-type": "application/json",
    "cosy-machinetype": sess.machineType,
    "cosy-clienttype": "5",
    "cosy-date": date,
    "cosy-user": sess.identity.uid,
    "cosy-key": sess.cosyKey,
    accept,
    authorization: bearer,
    "accept-encoding": "identity",
    "cosy-version": "0.1.43",
    "cosy-machineid": sess.machineId,
    "cosy-machinetoken": sess.machineToken,
    "login-version": "v2",
    "user-agent": "Go-http-client/2.0",
  };
}

function buildBearer(
  sess: SessionContext,
  date: string,
  body: string,
  pathSig: string,
): string {
  const payloadB64 = buildPayloadB64(sess.info);
  const sig = signRequest(payloadB64, sess.cosyKey, date, body, pathSig);
  return composeBearer(payloadB64, sig);
}

function sigPath(fullUrl: string): string {
  let path = new URL(fullUrl).pathname;
  if (path.startsWith("/algo")) path = path.slice("/algo".length);
  return path;
}

export async function callGet(
  sess: SessionContext,
  fullUrl: string,
): Promise<any> {
  const pathSig = sigPath(fullUrl);
  const body = "";
  const date = String(Math.floor(Date.now() / 1000));
  const bearer = buildBearer(sess, date, body, pathSig);
  const headers = commonBearerHeaders(sess, date, bearer, "application/json");

  const resp = await fetch(fullUrl, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (resp.status !== 200) {
    const detail = (await resp.text()).slice(0, 300);
    if (resp.status === 401 || resp.status === 403) {
      throw new QoderAuthError(resp.status, detail);
    }
    throw new Error(`HTTP ${resp.status} body=${detail}`);
  }
  return resp.json();
}

export interface StreamOptions {
  idleTimeoutMs?: number;
  connectTimeoutMs?: number;
}

export async function* openStreamLines(
  sess: SessionContext,
  fullUrl: string,
  jsonBody: Record<string, unknown>,
  extraHeaders: Record<string, string> | null,
  opts: StreamOptions = {},
): AsyncGenerator<string> {
  const pathSig = sigPath(fullUrl);
  const body = encode(
    new TextEncoder().encode(JSON.stringify(jsonBody)),
  );
  const date = String(Math.floor(Date.now() / 1000));
  const bearer = buildBearer(sess, date, body, pathSig);
  const headers = commonBearerHeaders(
    sess,
    date,
    bearer,
    "text/event-stream",
  );
  headers["cache-control"] = "no-cache";
  if (extraHeaders) Object.assign(headers, extraHeaders);

  const idleMs = opts.idleTimeoutMs ?? 300_000;
  const connectMs = opts.connectTimeoutMs ?? 15_000;
  const controller = new AbortController();
  let timeoutReason = "";
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const failWith = (reason: string) => {
    timeoutReason = reason;
    controller.abort();
  };
  const resetIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => failWith("stream read timeout"), idleMs);
  };

  try {
    connectTimer = setTimeout(
      () => failWith("stream connect timeout"),
      connectMs,
    );
    let resp: Response;
    try {
      resp = await fetch(fullUrl, {
        method: "POST",
        body,
        headers,
        signal: controller.signal,
      });
    } catch (e) {
      if (timeoutReason) throw new Error(timeoutReason);
      throw e;
    }
    if (connectTimer !== undefined) clearTimeout(connectTimer);

    if (resp.status !== 200 || !resp.body) {
      const errBody = (await resp.text()).slice(0, 300);
      if (resp.status === 401 || resp.status === 403) {
        throw new QoderAuthError(resp.status, errBody);
      }
      throw new Error(`HTTP ${resp.status} ${errBody}`);
    }

    resetIdle();
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const emitLine = (line: string): string | null => {
      const [isAuthErr, detail] = detectInStreamAuthError(line);
      if (isAuthErr) throw new QoderAuthError(401, detail);
      return line;
    };

    try {
      while (true) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (e) {
          if (timeoutReason) throw new Error(timeoutReason);
          throw e;
        }
        if (chunk.done) break;
        resetIdle();
        buf += decoder.decode(chunk.value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, "");
          buf = buf.slice(idx + 1);
          if (!line) continue;
          yield emitLine(line)!;
        }
      }
      buf += decoder.decode();
      if (buf.trim()) yield emitLine(buf)!;
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
  } finally {
    if (connectTimer !== undefined) clearTimeout(connectTimer);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
  }
}

export function detectInStreamAuthError(line: string): [boolean, string] {
  const s = line.trim();
  if (!s.startsWith("data:")) return [false, ""];
  let obj: any;
  try {
    obj = JSON.parse(s.slice(5).trim());
  } catch {
    return [false, ""];
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return [false, ""];
  }

  const scv = obj.statusCodeValue;
  if (scv === 401 || scv === 403) {
    return [true, `${scv} ${extractBodyMessage(obj)}`];
  }

  const msg = extractBodyMessage(obj);
  const bodyObj = parseBody(obj);
  if (
    bodyObj !== null &&
    typeof bodyObj === "object" &&
    !Array.isArray(bodyObj) &&
    (bodyObj.code === "105" || bodyObj.code === 105)
  ) {
    return [true, msg || "Login expired"];
  }
  return [false, ""];
}

function parseBody(obj: Record<string, any>): any {
  const body = obj.body;
  if (typeof body === "object" && body !== null) return body;
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
  return null;
}

function extractBodyMessage(obj: Record<string, any>): string {
  const bodyObj = parseBody(obj);
  if (typeof bodyObj === "object" && bodyObj !== null && !Array.isArray(bodyObj)) {
    return String(bodyObj.message || bodyObj.code || "");
  }
  return "";
}
