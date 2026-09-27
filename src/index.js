import {
  HttpError, MODEL_CATALOG, DEFAULT_MODEL,
  resolveCreds, saveCreds, refreshDeviceToken,
  prepareChat, streamDeltas, mapEffort, mapMessages, mapTools, mapParameters,
  findQueueInfo,
  jobTokenCacheState,
} from './qoder.js';
import { startLogin, waitLogin } from './login.js';
import { listCampaigns, runCheckin, lastCheckin, recordCheckin } from './checkin.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

function errResp(status, message, type = 'api_error') {
  return json({ error: { message, type, code: status } }, status);
}

function checkAuth(request, env) {
  const key = env.API_KEY;
  if (!key) return null;
  if ((request.headers.get('Authorization') || '') === `Bearer ${key}`) return null;
  return errResp(401, 'Invalid API key', 'authentication_error');
}

function modelList() {
  const now = Math.floor(Date.now() / 1000);
  return {
    object: 'list',
    data: MODEL_CATALOG.map(m => ({ id: m.id, object: 'model', created: now, owned_by: 'qoder', name: m.name })),
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            ...CORS,
            'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || 'Authorization, Content-Type',
          },
        });
      }

      if (request.method === 'GET' && (path === '/' || path === '/health')) {
        return json({ status: 'ok', service: 'qoder2api', endpoints: ['POST /v1/chat/completions', 'GET /v1/models'] });
      }

      if (request.method === 'GET' && (path === '/v1/models' || path === '/models')) {
        const denied = checkAuth(request, env);
        if (denied) return denied;
        return json(modelList());
      }

      if (request.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
        const denied = checkAuth(request, env);
        if (denied) return denied;
        return await handleChat(request, env); 
      }

      if (path.startsWith('/admin')) {
        const denied = checkAuth(request, env);
        if (denied) return denied;
        return await handleAdmin(request, env, path);
      }

      return errResp(404, `Unknown route: ${request.method} ${path}. Use POST /v1/chat/completions or GET /v1/models`, 'invalid_request_error');
    } catch (e) {
      if (e instanceof HttpError) return errResp(e.status, e.message, e.type);
      return errResp(500, e?.message || String(e));
    }
  },

  async scheduled(controller, env) {
    if (env.AUTO_CHECKIN === 'false') return;
    const at = new Date().toISOString();
    try {
      const result = await runCheckin(env);
      await recordCheckin(env, {
        at, ok: true, granted: result.granted, claimed: result.claimed,
        results: result.results,
      });
    } catch (e) {
      await recordCheckin(env, { at, ok: false, error: e?.message || String(e) });
    }
  },
};

async function handleAdmin(request, env, path) {
  if (request.method === 'POST' && path === '/admin/checkin') {
    const result = await runCheckin(env);
    await recordCheckin(env, {
      at: new Date().toISOString(), ok: true, granted: result.granted,
      claimed: result.claimed, results: result.results, manual: true,
    });
    return json(result);
  }
  if (request.method === 'GET' && path === '/admin/campaigns') {
    return json(await listCampaigns(env));
  }
  if (request.method === 'POST' && path === '/admin/login') {
    return json(await startLogin(env));
  }
  if (request.method === 'POST' && path === '/admin/login/wait') {
    let b = {};
    try { b = await request.json(); } catch { return errResp(400, 'Invalid JSON body', 'invalid_request_error'); }
    return json(await waitLogin(env, b.nonce, b.timeout));
  }
  if (request.method === 'DELETE' && path === '/admin/creds') {
    if (!env.QODER_KV) return errResp(400, '未绑定 QODER_KV, 无 KV 凭证可清除', 'configuration_error');
    await env.QODER_KV.delete('creds');
    await env.QODER_KV.delete('jobToken');
    return json({ ok: true });
  }
  if (request.method === 'POST' && path === '/admin/refresh') {
    const creds = await resolveCreds(env);
    const updated = await refreshDeviceToken(env, creds);
    return json({ ok: true, token: updated.token.slice(0, 12) + '...', expires_at: updated.expires_at || null, persisted: !!env.QODER_KV });
  }
  if (request.method === 'POST' && path === '/admin/creds') {
    if (!env.QODER_KV) return errResp(400, '未绑定 QODER_KV, 无法持久化凭证。请在 wrangler.toml 配置 KV 后重新部署', 'configuration_error');
    let c;
    try { c = await request.json(); } catch { return errResp(400, 'Invalid JSON body', 'invalid_request_error'); }
    if (!c || typeof c.token !== 'string' || !c.token) return errResp(400, '需要包含 token 的凭证 JSON (creds.json 内容)', 'invalid_request_error');
    await saveCreds(env, c);
    return json({ ok: true, token: c.token.slice(0, 12) + '...', machine_id: c.machine_id || null });
  }
  if (request.method === 'GET' && path === '/admin/status') {
    let creds = null, source = 'none';
    try { creds = await resolveCreds(env); source = env.QODER_KV ? 'kv-or-env' : 'env'; } catch (e) { return json({ configured: false, reason: e.message }); }
    const jt = jobTokenCacheState();
    return json({
      configured: true,
      source,
      token: creds.token ? creds.token.slice(0, 8) + '...' : null,
      has_refresh_token: !!creds.refresh_token,
      expires_at: creds.expires_at || null,
      refreshed_at: creds.refreshed_at || null,
      machine_id: (env.QODER_MACHINE_ID || creds.machine_id || '').slice(0, 8) || null,
      user: creds.userinfo ? { id: creds.userinfo.id, name: creds.userinfo.name } : null,
      jobToken_cached: !!jt,
      jobToken_expires_at: jt ? new Date(jt.expiresAt).toISOString() : null,
      last_checkin: await lastCheckin(env),
      kv_bound: !!env.QODER_KV,
      api_key_required: !!env.API_KEY,
    });
  }
  return errResp(404, `Unknown admin route: ${request.method} ${path}`, 'invalid_request_error');
}

function parseQueueInfo(inner) {
  if (inner?.code === undefined && inner?.statusCodeValue === undefined) return null;
  return findQueueInfo(inner);
}

function rebufferStream(reader, head) {
  const enc = new TextEncoder();
  let flushed = false;
  return new ReadableStream({
    async pull(ctrl) {
      if (!flushed) {
        flushed = true;
        if (head) ctrl.enqueue(enc.encode(head));
        return;
      }
      const { done, value } = await reader.read();
      if (done) ctrl.close();
      else ctrl.enqueue(value);
    },
  });
}

const QUEUE_MAX_ATTEMPTS = 5;
const QUEUE_DEFAULT_WAIT_MS = 2000;
const QUEUE_MAX_WAIT_MS = 30000;

const sleepMs = ms => new Promise(r => setTimeout(r, ms));

function queueWaitMs(q, maxWait) {
  let s = Number(q?.retryAfterSeconds);
  if (!Number.isFinite(s) || s <= 0) {
    const w = Number(q?.waitTime);
    s = Number.isFinite(w) && w > 0 ? (w >= 10 ? w : w / 1000) : 2;
  }
  return Math.min(maxWait, Math.max(1000, s * 1000));
}

async function openChatStream(env, chatOpts) {
  const maxAttempts = Number(env.QUEUE_MAX_ATTEMPTS) || QUEUE_MAX_ATTEMPTS;
  const maxWait = Number(env.QUEUE_MAX_WAIT_MS) || QUEUE_MAX_WAIT_MS;
  for (let attempt = 1; ; attempt++) {
    const prepared = await prepareChat(env, chatOpts);
    const res = await fetch(prepared.url, { method: 'POST', headers: prepared.headers, body: prepared.body });
    if (!res.ok) {
      const text = await res.text();
      let queue = null;
      try { queue = parseQueueInfo(JSON.parse(text)); } catch {}
      if (queue && attempt < maxAttempts) {
        await sleepMs(queueWaitMs(queue, maxWait));
        continue;
      }
      return { notOk: { status: queue ? 429 : res.status, text } };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', queued = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const i = buf.indexOf('\n\n');
      if (i === -1) continue;
      const line = buf.slice(0, i).split('\n').find(l => l.startsWith('data:'));
      if (line) {
        try {
          const env2 = JSON.parse(line.slice(5).trim());
          const inner = JSON.parse(env2.body || '{}');
          queued = parseQueueInfo(inner);
        } catch {}
      }
      break;
    }
    if (!queued || attempt >= maxAttempts) {
      return { res: { body: rebufferStream(reader, buf) } };
    }
    try { reader.cancel(); } catch {}
    await sleepMs(queueWaitMs(queued, maxWait));
  }
}

async function handleChat(request, env) {
  let reqBody;
  try { reqBody = await request.json(); } catch { return errResp(400, 'Invalid JSON body', 'invalid_request_error'); }
  const { model = DEFAULT_MODEL, messages, stream = false } = reqBody || {};
  if (!Array.isArray(messages) || messages.length === 0) return errResp(400, 'messages is required', 'invalid_request_error');
  let effort;
  try { effort = mapEffort(reqBody || {}); } catch (e) { return errResp(400, e.message, 'invalid_request_error'); }
  const mapped = mapMessages(messages);
  if (!mapped.length) return errResp(400, 'messages contains no valid roles (system|user|assistant|tool)', 'invalid_request_error');
  const tools = mapTools(reqBody?.tools);
  const parameters = mapParameters(reqBody || {});
  const includeUsage = reqBody?.stream_options?.include_usage === true;
  const id = 'chatcmpl-' + crypto.randomUUID().replaceAll('-', '').slice(0, 24);
  const created = Math.floor(Date.now() / 1000);

  let upstream;
  try {
    upstream = await openChatStream(env, { model, messages: mapped, tools, parameters, effort });
  } catch (e) {
    if (e instanceof HttpError) return errResp(e.status, e.message, e.type);
    return errResp(502, `upstream request failed: ${e?.message || e}`);
  }
  if (upstream.notOk) {
    const { status, text } = upstream.notOk;
    const mapped = [401, 402, 403, 429].includes(status) ? status : 502;
    return errResp(mapped, `gateway HTTP ${status}: ${text.slice(0, 300)}`);
  }

  if (!stream) {
    let text = '', thinking = '', finish = 'stop', usage = null;
    const toolCalls = [];
    for await (const ev of streamDeltas(upstream.res)) {
      if (ev.usage) usage = ev.usage;
      const d = ev.delta;
      if (d) {
        if (d.reasoning_content) thinking += d.reasoning_content;
        if (typeof d.content === 'string') text += d.content;
        for (const tc of d.tool_calls || []) {
          const idx = tc.index ?? toolCalls.length;
          toolCalls[idx] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.type) toolCalls[idx].type = tc.type;
          if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
        }
      }
      if (ev.finish) finish = ev.finish;
    }
    const message = { role: 'assistant', content: text || null };
    if (thinking) message.reasoning_content = thinking;
    if (toolCalls.length) message.tool_calls = toolCalls.filter(Boolean);
    return json({
      id, object: 'chat.completion', created, model,
      choices: [{ index: 0, message, finish_reason: finish }],
      usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(ctrl) {
      const send = obj => ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const chunk = (delta, finish = null, u = null) =>
        send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }], usage: u });
      chunk({ role: 'assistant', content: '' });
      let finish = 'stop', usage = null;
      try {
        for await (const ev of streamDeltas(upstream.res)) {
          if (ev.usage) usage = ev.usage;
          const d = ev.delta;
          if (d) {
            if (d.reasoning_content) chunk({ reasoning_content: d.reasoning_content });
            if (typeof d.content === 'string' && d.content) chunk({ content: d.content });
            if (Array.isArray(d.tool_calls) && d.tool_calls.length) chunk({ tool_calls: d.tool_calls });
          }
          if (ev.finish) finish = ev.finish;
        }
        chunk({}, finish, usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
        if (includeUsage) send({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
      } catch (e) {
        send({ error: { message: e?.message || String(e), type: 'api_error', code: e.status || 500 } });
      }
      ctrl.enqueue(encoder.encode('data: [DONE]\n\n'));
      ctrl.close();
    },
  });
  return new Response(body, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...CORS },
  });
}
