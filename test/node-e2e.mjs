import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import handler from '../src/index.js';

function makeRedPng(size = 64) {
  const rowSize = 1 + size * 3;
  const raw = Buffer.alloc(rowSize * size);
  for (let y = 0; y < size; y++) {
    raw[y * rowSize] = 0;
    for (let x = 0; x < size; x++) {
      const o = y * rowSize + 1 + x * 3;
      raw[o] = 220; raw[o + 1] = 30; raw[o + 2] = 30;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

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
  check('non-stream usage', typeof j.usage?.total_tokens === 'number' && j.usage.total_tokens > 0 && j.usage.prompt_tokens > 0, `total=${j.usage?.total_tokens} prompt=${j.usage?.prompt_tokens} credits=${j.usage?.credits}`);
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
  let content = '', reasoning = 0, stopOk = false, err = null, finishUsage = null;
  for (const l of lines.slice(0, -1)) {
    const p = l.slice(6).trim();
    if (!p) continue;
    const o = JSON.parse(p);
    if (o.error) { err = o.error; continue; }
    const d = o.choices?.[0]?.delta || {};
    if (d.reasoning_content) reasoning += d.reasoning_content.length;
    if (d.content) content += d.content;
    if (o.choices?.[0]?.finish_reason === 'stop') {
      stopOk = true;
      if (o.usage) finishUsage = o.usage;
    }
  }
  check('stream [DONE]', doneOk);
  check('stream stop chunk', stopOk);
  check('stream has content', content.length > 0, JSON.stringify(content.slice(0, 60)));
  check('stream no error event', !err, err ? JSON.stringify(err) : '');
  check('stream finish-chunk usage', typeof finishUsage?.total_tokens === 'number' && finishUsage.total_tokens > 0, `total=${finishUsage?.total_tokens}`);
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

const TOOLS_E2E = [{
  type: 'function',
  function: {
    name: 'get_weather',
    description: '查询指定城市的实时天气',
    parameters: { type: 'object', properties: { city: { type: 'string', description: '城市名' } }, required: ['city'] },
  },
}];

{
  let ok = false, detail = '';
  for (let attempt = 0; attempt < 2 && !ok; attempt++) {
    const r = await handler.fetch(req('/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key-123', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qfmodel',
        messages: [{ role: 'user', content: '北京今天天气怎么样？必须调用工具查询' }],
        tools: TOOLS_E2E,
      }),
    }), env, {});
    const j = await r.json();
    const m = j.choices?.[0]?.message;
    ok = r.status === 200 && Array.isArray(m?.tool_calls) && m.tool_calls.length > 0 &&
      m.tool_calls[0]?.function?.name === 'get_weather' &&
      typeof m.tool_calls[0]?.function?.arguments === 'string' &&
      j.choices[0].finish_reason === 'tool_calls';
    detail = `${r.status} ${JSON.stringify(m?.tool_calls?.[0]?.function || (m?.content || '').slice(0, 50) || j).slice(0, 120)}`;
  }
  check('non-stream tool_calls', ok, detail);
}

{
  let ok = false, detail = '';
  for (let attempt = 0; attempt < 2 && !ok; attempt++) {
    const r = await handler.fetch(req('/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key-123', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qfmodel', stream: true,
        messages: [{ role: 'user', content: '上海今天天气怎么样？必须调用工具查询' }],
        tools: TOOLS_E2E,
      }),
    }), env, {});
    const text = await r.text();
    const lines = text.split('\n').filter(l => l.startsWith('data: '));
    let sawToolCall = false, lastFinish = null;
    for (const l of lines) {
      const p = l.slice(6).trim();
      if (!p || p === '[DONE]') continue;
      try {
        const o = JSON.parse(p);
        if (o.choices?.[0]?.delta?.tool_calls?.length) sawToolCall = true;
        if (o.choices?.[0]?.finish_reason && o.choices[0].finish_reason !== 'null') lastFinish = o.choices[0].finish_reason;
      } catch {}
    }
    ok = r.status === 200 && sawToolCall && lastFinish === 'tool_calls' && lines[lines.length - 1] === 'data: [DONE]';
    detail = `${r.status} sawToolCall=${sawToolCall} finish=${lastFinish}`;
  }
  check('stream tool_calls', ok, detail);
}

{
  const r = await handler.fetch(req('/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-key-123', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qfmodel',
      messages: [
        { role: 'user', content: '北京今天天气怎么样？' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_e2e_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] },
        { role: 'tool', tool_call_id: 'call_e2e_1', content: '{"condition":"晴","temperature":"25C","wind":"东南风3级"}' },
      ],
      tools: TOOLS_E2E,
    }),
  }), env, {});
  const j = await r.json();
  const m = j.choices?.[0]?.message;
  const produced = (m?.content?.length || 0) > 0 || (Array.isArray(m?.tool_calls) && m.tool_calls.length > 0);
  check('tool result roundtrip', r.status === 200 && produced && !!j.choices?.[0]?.finish_reason,
    JSON.stringify((m?.content || '').slice(0, 60) || m?.tool_calls?.[0]?.function).slice(0, 100));
}

{
  const dataUrl = `data:image/png;base64,${makeRedPng().toString('base64')}`;
  let ok = false, detail = '';
  for (let attempt = 0; attempt < 2 && !ok; attempt++) {
    const r = await handler.fetch(req('/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key-123', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qfmodel',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '这张图片是什么颜色？只回答颜色名。' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        }],
      }),
    }), env, {});
    const j = await r.json();
    const answer = j.choices?.[0]?.message?.content || '';
    ok = r.status === 200 && /红|red/i.test(answer);
    detail = `${r.status} answer=${JSON.stringify(answer.slice(0, 60))}`;
  }
  check('vision image_url(data URL)', ok, detail);
}

console.log(failed ? `\n== ${failed} FAILED ==` : '\n== ALL PASS ==');
process.exit(failed ? 1 : 0);
