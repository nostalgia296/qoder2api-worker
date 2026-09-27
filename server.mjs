import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import worker from './src/index.js';
import { waitLogin } from './src/login.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find(a => a.startsWith(flag + '='));
  return eq ? eq.slice(flag.length + 1) : fallback;
}

const DOTENV_PATH = path.resolve(arg('--env', process.env.DOTENV_PATH || path.join(HERE, '.env')));

function loadDotEnv(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v && !(m[1] in process.env)) process.env[m[1]] = v;
  }
}

loadDotEnv(DOTENV_PATH);

const HOST = arg('--host', process.env.HOST || '127.0.0.1');
const PORT = Number(arg('--port', process.env.PORT || 8787));
const KV_PATH = path.resolve(arg('--kv', process.env.QODER_KV_PATH || path.join(HERE, '.qoder-kv.json')));

const CREDS_CANDIDATES = [
  arg('--creds', null),
  process.env.QODER_CREDS_PATH,
  path.join(HERE, 'creds.json'),
  path.join(HERE, '..', 'creds.json'),
].filter(Boolean).map(p => path.resolve(p));

const ENV_KEYS = [
  'API_KEY', 'QODER_CREDS_JSON', 'QODER_DEVICE_TOKEN', 'QODER_REFRESH_TOKEN',
  'QODER_USER_ID', 'QODER_USER_NAME', 'QODER_USER_EMAIL', 'QODER_MACHINE_ID',
];

let kvData = {};

function kvReload() {
  try {
    kvData = JSON.parse(fs.readFileSync(KV_PATH, 'utf8'));
  } catch {}
}

function kvPersist() {
  const dir = path.dirname(KV_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(KV_PATH)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(kvData, null, 2));
  fs.renameSync(tmp, KV_PATH);
}

const QODER_KV = {
  async get(key, type) {
    kvReload();
    const item = kvData[key];
    if (!item) return null;
    if (item.expiresAt && item.expiresAt < Date.now()) {
      delete kvData[key];
      kvPersist();
      return null;
    }
    return type === 'json' ? JSON.parse(item.value) : item.value;
  },
  async put(key, value, opts) {
    kvReload();
    const ttl = Number(opts && opts.expirationTtl);
    kvData[key] = {
      value: typeof value === 'string' ? value : String(value),
      expiresAt: ttl > 0 ? Date.now() + ttl * 1000 : null,
    };
    kvPersist();
    if (key === 'creds') {
      try {
        const t = JSON.parse(kvData.creds.value).token;
        console.log(`creds 已保存 ${KV_PATH} token=${t ? t.slice(0, 8) + '...' : '?'}`);
      } catch {}
    }
  },
  async delete(key) {
    kvReload();
    delete kvData[key];
    kvPersist();
  },
};

kvReload();

let credsCache = { path: null, mtime: -1, text: null };
function readCredsFile() {
  for (const p of CREDS_CANDIDATES) {
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (credsCache.path !== p || st.mtimeMs !== credsCache.mtime) {
      credsCache = { path: p, mtime: st.mtimeMs, text: fs.readFileSync(p, 'utf8') };
    }
    return credsCache.text;
  }
  return null;
}

function credsSource() {
  kvReload();
  if (kvData.creds) return KV_PATH;
  if (process.env.QODER_CREDS_JSON) return 'env QODER_CREDS_JSON';
  if (process.env.QODER_DEVICE_TOKEN) return 'env QODER_DEVICE_TOKEN';
  readCredsFile();
  return credsCache.path;
}

function buildEnv() {
  const env = { QODER_KV };
  for (const k of ENV_KEYS) if (process.env[k]) env[k] = process.env[k];
  kvReload();
  if (!env.QODER_CREDS_JSON && !env.QODER_DEVICE_TOKEN && !kvData.creds) {
    const fileCreds = readCredsFile();
    if (fileCreds) env.QODER_CREDS_JSON = fileCreds;
  }
  return env;
}

function toRequest(req) {
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  }
  const host = headers.get('host') || `${HOST}:${PORT}`;
  const init = { method: req.method, headers, duplex: 'half' };
  if (req.method !== 'GET' && req.method !== 'HEAD') init.body = Readable.toWeb(req);
  return new Request(`http://${host}${req.url}`, init);
}

async function pump(webBody, res) {
  const reader = webBody.getReader();
  const abort = () => reader.cancel().catch(() => {});
  res.once('close', abort);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise(r => res.once('drain', r));
    }
  } finally {
    res.removeListener('close', abort);
    reader.releaseLock();
  }
}

let waitInFlight = 0;

const server = http.createServer((req, res) => {
  const send = (status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };
  let webReq;
  try {
    webReq = toRequest(req);
  } catch (e) {
    return send(400, { error: { message: String(e?.message || e), type: 'invalid_request_error', code: 400 } });
  }
  const isWait = req.method === 'POST' && (webReq.url || '').includes('/admin/login/wait');
  if (isWait) {
    waitInFlight++;
    res.once('close', () => { waitInFlight--; });
  }
  worker.fetch(webReq, buildEnv(), {})
    .then(async response => {
      const headers = Object.fromEntries(response.headers);
      if (response.body && !headers['content-length']) headers['Transfer-Encoding'] = 'chunked';
      res.writeHead(response.status, headers);
      if (req.method === 'HEAD' || !response.body) return res.end();
      await pump(response.body, res);
      res.end();
    })
    .catch(e => {
      if (res.headersSent) return res.end();
      send(500, { error: { message: String(e?.message || e), type: 'api_error', code: 500 } });
    });
});

let loginWatchBusy = false;
async function watchLogins() {
  if (loginWatchBusy || waitInFlight) return;
  loginWatchBusy = true;
  try {
    kvReload();
    const nonces = Object.keys(kvData)
      .filter(k => k.startsWith('login:'))
      .map(k => k.slice(6));
    if (!nonces.length) return;
    const env = buildEnv();
    for (const nonce of nonces) {
      let r;
      try {
        r = await waitLogin(env, nonce, 1000);
      } catch {
        continue;
      }
      if (r.ok) console.log(`登录完成  ${r.user?.name || ''} ${r.user?.email || ''}`);
    }
  } finally {
    loginWatchBusy = false;
  }
}
setInterval(watchLogins, 1500).unref();

server.listen(PORT, HOST, () => {
  const env = buildEnv();
  const base = `http://${HOST}:${PORT}`;
  const src = credsSource();
  console.log(`qoder2api  ${base}/v1`);
  console.log(`kv     ${KV_PATH}${kvData.creds ? ' (含 creds)' : ''}`);
  console.log(`creds  ${src || '未配置（creds.json / QODER_CREDS_JSON / POST /admin/login）'}`);
  console.log(`auth   ${env.API_KEY ? 'API_KEY 已启用' : '未设置 API_KEY（本地免鉴权）'}`);
  if (!kvData.creds && Object.keys(kvData).some(k => k.startsWith('login:'))) {
    console.log('待完成   检测到未完成的登录会话, 浏览器授权后会自动保存凭证');
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => {
      server.closeAllConnections?.();
      process.exit(0);
    }, 2000).unref();
  });
}
