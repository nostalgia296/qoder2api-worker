import { initAuthWasm, QoderContext } from './wasm/glue.js';
import { uuid, bytesToB64, aesCbcEncrypt, rsaPkcs1v15Encrypt } from './crypto.js';

export const OPENAPI = 'https://openapi.qoder.com.cn';
export const GATEWAY = 'https://gateway.qoder.com.cn';
export const CLIENT_ID = '732aef47-9cf2-46a2-95fe-4cebb5d0d1fa';
export const COSY_VERSION = '1.1.53';
const CLIENT_META = JSON.stringify({ client_type: '5', business_product: 'cli', business_type: 'agent', scene: 'assistant' });

export const DEFAULT_MODEL = 'qfmodel';

export const MODEL_CATALOG = [
  { id: 'auto', name: 'Auto' },
  { id: 'lite', name: 'Lite' },
  { id: 'qfmodel', name: 'Qwen3.8-Flash' },
  { id: 'qmodel', name: 'Qwen3.7-Plus' },
  { id: 'qmodel_38max', name: 'Qwen3.8-Max' },
  { id: 'qmodel_latest', name: 'Qwen Latest' },
  { id: 'dfmodel', name: 'DeepSeek-V4-Flash' },
  { id: 'dmodel', name: 'DeepSeek-V4-Pro' },
  { id: 'gfmodel', name: 'GLM-5.3-Flash' },
  { id: 'gmodel', name: 'GLM-5.3' },
  { id: 'kmodel', name: 'Kimi-K2.7-Code' },
  { id: 'kmodel_latest', name: 'Kimi-K2.7-Code-Latest' },
  { id: 'mmodel', name: 'MiniMax-M3' },
  { id: 'cmodel', name: 'Cantus' },
];

export class HttpError extends Error {
  constructor(status, message, type = 'api_error') {
    super(message);
    this.status = status;
    this.type = type;
  }
}

export async function resolveCreds(env) {
  if (env.QODER_KV) {
    try {
      const c = await env.QODER_KV.get('creds', 'json');
      if (c && c.token) return c;
    } catch {}
  }
  if (env.QODER_CREDS_JSON) {
    try {
      const c = typeof env.QODER_CREDS_JSON === 'string' ? JSON.parse(env.QODER_CREDS_JSON) : env.QODER_CREDS_JSON;
      if (c && c.token) return c;
    } catch {}
  }
  if (env.QODER_DEVICE_TOKEN) {
    return {
      token: env.QODER_DEVICE_TOKEN,
      refresh_token: env.QODER_REFRESH_TOKEN || '',
      userinfo: { id: env.QODER_USER_ID || '', name: env.QODER_USER_NAME || '', email: env.QODER_USER_EMAIL || '' },
      machine_id: env.QODER_MACHINE_ID || '',
    };
  }
  throw new HttpError(500, '凭证未配置: 用 `wrangler secret put QODER_CREDS_JSON` 上传 creds.json 内容; 或绑定 QODER_KV 后 POST /admin/creds 写入', 'configuration_error');
}

export async function saveCreds(env, creds) {
  if (env.QODER_KV) await env.QODER_KV.put('creds', JSON.stringify(creds));
}

let refreshInFlight = null;
export function refreshDeviceToken(env, creds) {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      if (!creds.refresh_token) throw new HttpError(401, 'deviceToken 已失效且无 refresh_token, 需重新运行 node qoder-login.mjs');
      const r = await fetch(new URL('/api/v1/deviceToken/refresh', OPENAPI), {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: creds.refresh_token }),
      });
      if (r.status === 400 || r.status === 401 || r.status === 403) {
        throw new HttpError(401, 'refresh_token 已失效, 请重新运行 node qoder-login.mjs 并更新凭证');
      }
      if (!r.ok) throw new HttpError(502, `deviceToken/refresh HTTP ${r.status}`);
      const d = await r.json();
      const token = d.token ?? d.device_token;
      if (typeof token !== 'string' || typeof d.refresh_token !== 'string') {
        throw new HttpError(502, 'refresh 响应缺少 token/refresh_token');
      }
      const updated = { ...creds, token, refresh_token: d.refresh_token };
      if (d.expires_at || d.expires_in) {
        updated.expires_at = d.expires_at || new Date(Date.now() + Number(d.expires_in)).toISOString();
      }
      updated.refreshed_at = new Date().toISOString();
      await saveCreds(env, updated);
      return updated;
    })().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

let jobTokenCache = null; 

export function jobTokenCacheState() {
  return jobTokenCache;
}

async function fetchJobToken(deviceToken) {
  const r = await fetch(new URL('/api/v1/me/jobToken', OPENAPI), {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${deviceToken}`, 'User-Agent': 'Qoder' },
    body: JSON.stringify({ clientId: CLIENT_ID }),
  });
  return r;
}

async function getJobToken(env, creds) {
  if (jobTokenCache && jobTokenCache.expiresAt > Date.now() + 60_000) return jobTokenCache.token;
  if (env.QODER_KV) {
    try {
      const j = await env.QODER_KV.get('jobToken', 'json');
      if (j && j.token && j.expiresAt > Date.now() + 60_000) {
        jobTokenCache = j;
        return j.token;
      }
    } catch {}
  }

  let r = await fetchJobToken(creds.token);
  if (r.status === 401 || r.status === 403) {
    const updated = await refreshDeviceToken(env, creds);
    r = await fetchJobToken(updated.token);
  }
  if (!r.ok) throw new HttpError(502, `jobToken HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const cache = {
    token: j.token,
    expiresAt: j.expires_at ? Date.parse(j.expires_at) : Date.now() + 23 * 3600e3,
  };
  jobTokenCache = cache;
  if (env.QODER_KV) {
    const ttl = Math.max(60, Math.floor((cache.expiresAt - Date.now()) / 1000) - 60);
    try { await env.QODER_KV.put('jobToken', JSON.stringify(cache), { expirationTtl: ttl }); } catch {}
  }
  return cache.token;
}

async function makeUserCredential(creds) {
  const aesKeyStr = uuid().replaceAll('-', '').slice(0, 16);
  const aesKey = new TextEncoder().encode(aesKeyStr); 
  const ui = creds.userinfo || {};
  const info = bytesToB64(await aesCbcEncrypt(aesKey, aesKey, new TextEncoder().encode(JSON.stringify({
    uid: ui.id || '',
    aid: '',
    name: ui.name || '',
    email: ui.email || '',
    security_oauth_token: creds.token,
  }))));
  const key = bytesToB64(rsaPkcs1v15Encrypt(aesKey));
  return JSON.stringify({ uid: ui.id || '', encrypt_user_info: info, key });
}

let ctxCache = null; 

async function withContext(machineId, userInfoJson, fn) {
  await initAuthWasm();
  const key = machineId + '|' + userInfoJson;
  if (!ctxCache || ctxCache.key !== key) {
    if (ctxCache) { try { ctxCache.ctx.free(); } catch {} }
    ctxCache = { key, ctx: new QoderContext(machineId, COSY_VERSION, userInfoJson, CLIENT_META) };
  }
  try {
    return fn(ctxCache.ctx);
  } catch (e) {
    if (e instanceof TypeError) { 
      try { ctxCache.ctx.free(); } catch {}
      ctxCache = { key, ctx: new QoderContext(machineId, COSY_VERSION, userInfoJson, CLIENT_META) };
      return fn(ctxCache.ctx);
    }
    throw e;
  }
}

export function mapEffort(reqBody) {
  let e = reqBody.reasoning_effort ?? reqBody.reasoning?.effort ?? reqBody.thinking_effort;
  if (e === undefined) return undefined;
  e = String(e).toLowerCase().trim();
  const map = { minimal: 'low', off: 'none', disabled: 'none', false: 'none', none: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
  const v = map[e];
  if (!v) throw new HttpError(400, `Invalid reasoning_effort "${e}". Valid: none|minimal|low|medium|high|xhigh|max|off`, 'invalid_request_error');
  return v;
}

function mapParts(parts) {
  const out = [];
  for (const p of parts || []) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'text') out.push({ type: 'text', text: p.text || '' });
    else if (p.type === 'image_url' && p.image_url?.url) {
      out.push({ type: 'image_url', image_url: { url: p.image_url.url, ...(p.image_url.detail ? { detail: p.image_url.detail } : {}) } });
    } else if (p.type === 'input_audio' && p.input_audio?.data) {
      out.push({ type: 'input_audio', input_audio: { data: p.input_audio.data, format: p.input_audio.format } });
    }
  }
  return out;
}

export function mapMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    const role = m.role === 'developer' ? 'system' : m.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') continue;
    const msg = { role };
    const c = m.content ?? m.contents;
    const content = typeof c === 'string' || c === null ? c
      : Array.isArray(c) ? mapParts(c)
      : undefined;
    if (content !== undefined) msg.content = content;
    if (m.name) msg.name = m.name;
    if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      msg.tool_calls = m.tool_calls.map(tc => ({
        ...(tc.index !== undefined ? { index: tc.index } : {}),
        id: tc.id,
        type: tc.type ?? 'function',
        function: { name: tc.function?.name, arguments: tc.function?.arguments ?? '' },
      }));
    }
    if (role === 'tool' && m.tool_call_id) msg.tool_call_id = m.tool_call_id;
    if (role === 'assistant' && typeof m.reasoning_content === 'string' && m.reasoning_content) msg.reasoning_content = m.reasoning_content;
    out.push(msg);
  }
  return out;
}

export function mapTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  const mapped = tools
    .filter(t => t?.type === 'function' && t.function?.name)
    .map(t => ({
      type: 'function',
      function: {
        name: t.function.name,
        ...(t.function.description ? { description: t.function.description } : {}),
        ...(t.function.parameters ? { parameters: t.function.parameters } : {}),
        ...(t.function.strict !== undefined ? { strict: t.function.strict } : {}),
      },
    }));
  return mapped.length ? mapped : undefined;
}

export function mapParameters(reqBody) {
  const p = {};
  if (reqBody.tool_choice !== undefined) p.tool_choice = reqBody.tool_choice;
  if (typeof reqBody.parallel_tool_calls === 'boolean') p.parallel_tool_calls = reqBody.parallel_tool_calls;
  if (reqBody.response_format !== undefined) p.response_format = reqBody.response_format;
  return Object.keys(p).length ? p : undefined;
}

export async function prepareChat(env, { model, messages, tools, parameters, effort }) {
  const creds = await resolveCreds(env);
  const jobToken = await getJobToken(env, creds);
  const requestId = uuid(), sessionId = uuid();
  const bodyObj = {
    model, stream: true,
    request_id: requestId, request_set_id: uuid(), session_id: sessionId,
    messages,
    model_config: {
      key: model, display_name: model, model: '', format: 'openai', is_vl: true, is_reasoning: true,
      api_key: jobToken, url: '', source: 'system', max_input_tokens: 180000,
    },
    business: { product: 'qoderapp', version: COSY_VERSION, type: 'chat' },
    context: { request_id: requestId, session_id: sessionId, client_type: 'qoderapp' },
  };
  if (effort) bodyObj.reasoning_effort = effort;
  if (tools) bodyObj.tools = tools;
  if (parameters) bodyObj.parameters = parameters;

  const machineId = env.QODER_MACHINE_ID || creds.machine_id || uuid();
  const userInfoJson = await makeUserCredential(creds);
  const prepared = await withContext(machineId, userInfoJson, ctx =>
    ctx.prepareInferRequest(GATEWAY, JSON.stringify(bodyObj), model, 'system'));
  const url = prepared.url;
  const headers = {};
  prepared.headers.forEach((v, k) => { headers[k] = v; });
  const bodyStr = String(prepared.body);
  try { prepared.free(); } catch {}
  headers['User-Agent'] = 'undici';
  if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (!headers['Accept']) headers['Accept'] = 'text/event-stream';
  return { url, headers, body: bodyStr };
}

export async function* streamDeltas(response) {
  const reader = response.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const p = line.slice(5).trim();
        if (!p) continue;
        let inner;
        try {
          const env2 = JSON.parse(p);
          inner = JSON.parse(env2.body || '{}');
        } catch { continue; }
        if (inner.code) throw new HttpError(Number(inner.statusCodeValue) || 502, inner.message || 'gateway error');
        const ch = inner.choices?.[0];
        const d = ch ? (ch.delta ?? ch.message ?? null) : null;
        const hasDelta = d && (d.content || d.reasoning_content || (Array.isArray(d.tool_calls) && d.tool_calls.length));
        const finish = ch?.finish_reason && ch.finish_reason !== 'null' ? ch.finish_reason : undefined;
        if (hasDelta || finish || inner.usage) {
          yield { delta: hasDelta ? d : null, finish, usage: inner.usage ?? null };
        }
      }
    }
  }
}
