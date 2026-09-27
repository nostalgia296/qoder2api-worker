import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CREDS_PATH = process.argv[2] || path.join(HERE, '..', '..', 'creds.json');
const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));

const kvStore = new Map();
const kv = {
  async get(key, opts) {
    const v = kvStore.get(key);
    if (v === undefined) return null;
    return opts === 'json' ? JSON.parse(v) : v;
  },
  async put(key, value) { kvStore.set(key, value); },
};
let kvHits = 0;

const env = {
  QODER_CREDS_JSON: JSON.stringify(creds),
  QODER_KV: new Proxy(kv, {
    get(t, prop) {
      if (prop === 'get') return async (...a) => { const r = await t.get(...a); if (r) kvHits++; return r; };
      return t[prop];
    },
  }),
  API_KEY: 'test-key-123',
};

const req = (path, init) => new Request(`http://localhost${path}`, init);

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

{
  const r = await handler.fetch(req('/health'), env, {});
  check('GET /health', r.status === 200);
}
{
  const r = await handler.fetch(req('/v1/models', { headers: { Authorization: 'Bearer test-key-123' } }), env, {});
  const j = await r.json();
  check('GET /v1/models', r.status === 200 && j.data?.length >= 10, `${j.data?.length} models`);
}
{
  const r = await handler.fetch(req('/v1/models', { headers: { Authorization: 'Bearer wrong' } }), env, {});
  check('auth rejection', r.status === 401);
}
{
  const r = await handler.fetch(req('/v1/chat/completions', {
    method: 'POST', headers: { Authorization: 'Bearer test-key-123', 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [] }),
  }), env, {});
  check('empty messages 400', r.status === 400);
}

{
  const t0 = Date.now();
  const r = await handler.fetch(req('/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-key-123', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qfmodel', messages: [{ role: 'system', content: '你是简洁的助手' }, { role: 'user', content: '用一句话介绍你自己' }] }),
  }), env, {});
  const j = await r.json();
  check('non-stream 200', r.status === 200, `${Date.now() - t0}ms`);
  check('non-stream content', typeof j.choices?.[0]?.message?.content === 'string' && j.choices[0].message.content.length > 0, JSON.stringify(j.choices?.[0]?.message?.content?.slice(0, 60)));
  check('non-stream shape', j.object === 'chat.completion' && j.id.startsWith('chatcmpl-') && j.choices[0].finish_reason === 'stop');
}

{
  const r = await handler.fetch(req('/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-key-123', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qfmodel', stream: true, reasoning_effort: 'low', messages: [{ role: 'user', content: '9.11 和 9.9 哪个大？一句话回答' }] }),
  }), env, {});
  check('stream 200 + SSE header', r.status === 200 && (r.headers.get('content-type') || '').includes('text/event-stream'));
  const text = await r.text();
  const lines = text.split('\n').filter(l => l.startsWith('data: '));
  const doneOk = lines[lines.length - 1] === 'data: [DONE]';
  let content = '', reasoning = 0, stopOk = false, err = null;
  for (const l of lines.slice(0, -1)) {
    const p = l.slice(6).trim();
    if (!p) continue;
    const o = JSON.parse(p);
    if (o.error) { err = o.error; continue; }
    const d = o.choices?.[0]?.delta || {};
    if (d.reasoning_content) reasoning += d.reasoning_content.length;
    if (d.content) content += d.content;
    if (o.choices?.[0]?.finish_reason === 'stop') stopOk = true;
  }
  check('stream [DONE]', doneOk);
  check('stream stop chunk', stopOk);
  check('stream has content', content.length > 0, JSON.stringify(content.slice(0, 60)));
  check('stream no error event', !err, err ? JSON.stringify(err) : '');
}

{
  const before = kvHits;
  const r = await handler.fetch(req('/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-key-123', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qfmodel', messages: [{ role: 'user', content: '回复"ok"两个字母即可' }] }),
  }), env, {});
  const j = await r.json();
  check('kv re-request 200', r.status === 200 && (j.choices?.[0]?.message?.content?.length || 0) > 0, `kvHits ${before}→${kvHits}`);
}

{
  const r = await handler.fetch(req('/admin/status', { headers: { Authorization: 'Bearer test-key-123' } }), env, {});
  const j = await r.json();
  check('admin/status', r.status === 200 && j.configured === true && j.kv_bound === true);
}

{
  const r = await handler.fetch(req('/v1/chat/completions', { method: 'OPTIONS', headers: { 'Access-Control-Request-Headers': 'authorization, content-type' } }), env, {});
  check('CORS preflight', r.status === 204 && r.headers.get('access-control-allow-origin') === '*');
}

{
  const r = await handler.fetch(req('/admin/login', { method: 'POST', headers: { Authorization: 'Bearer test-key-123' } }), env, {});
  const j = await r.json();
  const urlOk = typeof j.login_url === 'string' && j.login_url.startsWith('https://qoder.cn/users/sign-in?') &&
    j.login_url.includes('biz_variant=qoder') && j.login_url.includes('oauth_callback=');
  check('login start', r.status === 200 && !!j.nonce && urlOk, `${j.login_url?.slice(0, 60)}...`);

  const r2 = await handler.fetch(req('/admin/login/wait', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-key-123', 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce: j.nonce, timeout: 2500 }),
  }), env, {});
  const j2 = await r2.json();
  check('login wait pending(未授权)', r2.status === 200 && j2.ok === false && j2.reason === 'pending', `reason=${j2.reason}`);

  const r3 = await handler.fetch(req('/admin/login/wait', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-key-123', 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce: '00000000-0000-4000-8000-000000000000', timeout: 1000 }),
  }), env, {});
  check('login wait bad nonce 404', r3.status === 404);
}

console.log(failed ? `\n== ${failed} FAILED ==` : '\n== ALL PASS ==');
process.exit(failed ? 1 : 0);
